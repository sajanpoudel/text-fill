#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from mcp_agent.agents.agent import Agent
from mcp_agent.app import MCPApp
from mcp_agent.config import LoggerSettings, MCPServerSettings, MCPSettings, Settings


VERIFY_INSERT_FUNCTION = """
(selector, expectedText) => {
  const element = document.querySelector(selector);
  if (!element) return false;
  const text =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : element.isContentEditable
        ? element.innerText || element.textContent || ""
        : element.innerText || element.textContent || "";
  const normalize = (value) => value.replace(/\\s+/g, " ").trim().toLowerCase();
  const haystack = normalize(text);
  const needle = normalize(expectedText);
  return needle.length > 0 && haystack.includes(needle);
}
""".strip()


def normalize_error_message(error: Exception) -> str:
    message = str(error)

    if "DevToolsActivePort" in message:
        return (
            "Chrome DevTools MCP could not attach to your running Chrome profile. "
            "Chrome is running, but remote debugging is not enabled for the default profile. "
            "Open chrome://inspect/#remote-debugging in Chrome, enable remote debugging, "
            "and allow incoming debugging connections. Then reload the extension and try again. "
            "Alternative: start Chrome with --remote-debugging-port=9222 and set "
            "CHROME_DEVTOOLS_MCP_BROWSER_URL=http://127.0.0.1:9222."
        )

    if (
        ("127.0.0.1:9222" in message or "localhost:9222" in message)
        and (
            "ECONNREFUSED" in message
            or "Failed to fetch browser webSocket URL" in message
            or "Could not connect to browser" in message
        )
    ):
        return (
            "Chrome DevTools MCP could not reach the configured remote-debugging endpoint. "
            "Start Chrome with --remote-debugging-port=9222 first, or remove "
            "CHROME_DEVTOOLS_MCP_BROWSER_URL so the runtime can use --autoConnect instead."
        )

    return message


def build_chrome_devtools_mcp_args() -> list[str]:
    raw_args_json = os.getenv("CHROME_DEVTOOLS_MCP_ARGS_JSON", "").strip()
    if raw_args_json:
        parsed = json.loads(raw_args_json)
        if not isinstance(parsed, list) or not all(
            isinstance(item, str) for item in parsed
        ):
            raise ValueError("CHROME_DEVTOOLS_MCP_ARGS_JSON must be a JSON string array")
        return parsed

    args = ["-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"]

    browser_url = os.getenv("CHROME_DEVTOOLS_MCP_BROWSER_URL", "").strip()
    if browser_url:
        args.append(f"--browser-url={browser_url}")
    elif os.getenv("CHROME_DEVTOOLS_MCP_AUTO_CONNECT", "1") != "0":
        args.append("--autoConnect")

    if os.getenv("CHROME_DEVTOOLS_MCP_HEADLESS", "0") == "1":
        args.append("--headless")
    if os.getenv("CHROME_DEVTOOLS_MCP_ISOLATED", "0") == "1":
        args.append("--isolated")

    channel = os.getenv("CHROME_DEVTOOLS_MCP_CHANNEL", "").strip()
    if channel:
        args.append(f"--channel={channel}")

    user_data_dir = os.getenv("CHROME_DEVTOOLS_MCP_USER_DATA_DIR", "").strip()
    if user_data_dir:
        args.append(f"--userDataDir={user_data_dir}")

    return args


def build_settings() -> Settings:
    cwd = os.getenv("MCP_AGENT_BRIDGE_CWD", "").strip() or os.getcwd()
    command = os.getenv("CHROME_DEVTOOLS_MCP_COMMAND", "").strip() or "npx"
    allowed_env = {
        key: value for key, value in os.environ.items() if isinstance(value, str)
    }

    return Settings(
        name="cheatresume_python_browser_runtime",
        execution_engine="asyncio",
        logger=LoggerSettings(
            type="none",
            transports=["none"],
            level="error",
            progress_display=False,
        ),
        mcp=MCPSettings(
            servers={
                "chrome-devtools": MCPServerSettings(
                    transport="stdio",
                    command=command,
                    args=build_chrome_devtools_mcp_args(),
                    cwd=cwd,
                    env=allowed_env,
                )
            }
        ),
    )


def tool_result_text(result: Any) -> str:
    content = getattr(result, "content", None)
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n".join(parts)


def is_tool_error(result: Any) -> bool:
    return bool(getattr(result, "isError", False))


def parse_page_list(text: str) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not re.match(r"^\d+:\s+", stripped):
            continue
        match = re.match(r"^(\d+):\s+(.+?)(\s+\[selected\])?$", stripped)
        if not match:
            continue
        pages.append(
            {
                "pageId": int(match.group(1)),
                "url": match.group(2).strip(),
                "selected": bool(match.group(3)),
            }
        )
    return pages


def parse_evaluate_result(result: Any) -> Any:
    structured_content = getattr(result, "structuredContent", None)
    if isinstance(structured_content, dict) and "result" in structured_content:
        return structured_content["result"]

    text = tool_result_text(result)
    fenced_match = re.search(r"```json\s*([\s\S]*?)\s*```", text)
    if fenced_match:
        return json.loads(fenced_match.group(1).strip())

    fallback_match = re.search(r"returned:\s*([\s\S]+)$", text)
    if fallback_match:
        return json.loads(fallback_match.group(1).strip())

    raise RuntimeError("Chrome DevTools MCP returned an unreadable script result")


def urls_match_for_command_routing(page_url: str | None, target_url: str) -> bool:
    if not page_url:
        return False

    try:
        current = urlparse(page_url)
        target = urlparse(target_url)
        if page_url == target_url:
            return True
        if (
            current.scheme != target.scheme
            or current.netloc != target.netloc
        ):
            return False
        return current.path.startswith(target.path)
    except Exception:
        return page_url == target_url


def build_linkedin_custom_invite_url(target_url: str) -> str | None:
    try:
        parsed = urlparse(target_url)
        if not parsed.netloc.endswith("linkedin.com"):
            return None
        match = re.match(r"^/in/([^/?#]+)/?", parsed.path, re.IGNORECASE)
        if not match:
            return None
        vanity_name = match.group(1).strip()
        if not vanity_name:
            return None
        return (
            "https://www.linkedin.com/preload/custom-invite/?vanityName="
            f"{quote(vanity_name)}"
        )
    except Exception:
        return None


def summarize_linkedin_connect_debug(result: dict[str, Any] | None) -> str | None:
    debug = result.get("debug") if isinstance(result, dict) else None
    if not isinstance(debug, dict):
        return None

    parts: list[str] = []
    primary = debug.get("primaryButtons")
    menu = debug.get("menuOptions")
    dialog = debug.get("dialogButtons")
    path = debug.get("resolutionPath")
    if isinstance(primary, list) and primary:
        parts.append(f"primary={', '.join(str(item) for item in primary[:5])}")
    if isinstance(menu, list) and menu:
        parts.append(f"menu={', '.join(str(item) for item in menu[:5])}")
    if isinstance(dialog, list) and dialog:
        parts.append(f"dialog={', '.join(str(item) for item in dialog[:5])}")
    if isinstance(path, list) and path:
        parts.append(f"path={' -> '.join(str(item) for item in path[:8])}")
    return " | ".join(parts) if parts else None


def should_retry_linkedin_connect_with_custom_invite(final_state: str) -> bool:
    return final_state in {
        "dialog_not_found",
        "no_connect_control",
        "menu_connect_not_found",
    }


def human_delay(base_ms: int) -> int:
    u1 = random.random()
    u2 = random.random()
    z = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
    return max(1000, round(base_ms + z * base_ms * 0.3))


def serialize_result(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return {key: serialize_result(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize_result(item) for item in value]
    return value


def load_browser_control_bundle(cwd: str) -> dict[str, str]:
    root = Path(cwd)
    script_path = root / "companion" / "export-browser-control-bundle.ts"
    local_tsx = root / "node_modules" / ".bin" / "tsx"

    if local_tsx.exists():
        command = [str(local_tsx), str(script_path)]
    else:
        command = ["npx", "tsx", str(script_path)]

    completed = subprocess.run(
        command,
        cwd=cwd,
        env={
            **os.environ,
            "NODE_NO_WARNINGS": "1",
        },
        capture_output=True,
        text=True,
        check=True,
    )
    parsed = json.loads(completed.stdout)
    functions = parsed.get("functions")
    if not isinstance(functions, dict):
        raise RuntimeError("Browser control bundle is missing function sources")

    required = [
        "executeInsertTextBySelectorInPage",
        "executeWaitForLinkedInPrimaryActionsInPage",
        "executeLinkedInConnectWorkflowInPage",
        "isLinkedInAddNoteText",
        "isLinkedInSendText",
        "isLinkedInFinalSendText",
        "isBackgroundTabLayoutUnavailable",
    ]
    for name in required:
        if not isinstance(functions.get(name), str) or not functions[name].strip():
            raise RuntimeError(f"Browser control bundle is missing {name}")
    return functions


def build_function_source(
    main_source: str, dependencies: dict[str, str] | None = None
) -> str:
    dependency_source = "\n".join(
        f"const {name} = {source};"
        for name, source in (dependencies or {}).items()
    )
    return f"""(...args) => {{
{dependency_source}
return ({main_source})(...args);
}}"""


async def read_request_line() -> str:
    return await asyncio.to_thread(sys.stdin.readline)


def write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


class PythonBrowserRuntime:
    def __init__(self, agent: Agent, bundle: dict[str, str]):
        self.agent = agent
        self.bundle = bundle

    async def call_tool(
        self, name: str, args: dict[str, Any] | None = None
    ) -> Any:
        result = await self.agent.call_tool(
            name,
            args or {},
            server_name="chrome-devtools",
        )
        if is_tool_error(result):
            message = tool_result_text(result).strip()
            raise RuntimeError(message or f"Chrome DevTools MCP tool failed: {name}")
        return result

    async def list_pages(self) -> list[dict[str, Any]]:
        result = await self.call_tool("list_pages")
        return parse_page_list(tool_result_text(result))

    async def select_page(self, page_id: int, bring_to_front: bool = False) -> None:
        args: dict[str, Any] = {"pageId": page_id}
        if bring_to_front:
            args["bringToFront"] = True
        await self.call_tool("select_page", args)

    async def evaluate_on_page(
        self,
        *,
        page_id: int,
        function_source: str,
        args: list[Any] | None = None,
        bring_to_front: bool = False,
    ) -> Any:
        await self.select_page(page_id, bring_to_front)
        payload: dict[str, Any] = {"function": function_source}
        if args:
            payload["args"] = args
        result = await self.call_tool("evaluate_script", payload)
        return parse_evaluate_result(result)

    async def wait_for_page_ready(self, page_id: int, timeout_ms: int = 15000) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
        while asyncio.get_running_loop().time() < deadline:
            ready_state = await self.evaluate_on_page(
                page_id=page_id,
                function_source="() => document.readyState",
            )
            if ready_state in {"complete", "interactive"}:
                return
            await asyncio.sleep(0.2)
        raise RuntimeError("Timed out waiting for the page to finish loading")

    async def find_page_by_url(self, page_url: str) -> dict[str, Any] | None:
        pages = await self.list_pages()
        for page in pages:
            if page.get("url") == page_url:
                return page
        for page in pages:
            if urls_match_for_command_routing(page.get("url"), page_url):
                return page
        return None

    async def open_page(self, url: str, background: bool = False) -> dict[str, Any]:
        before = await self.list_pages()
        before_page_ids = {page["pageId"] for page in before}
        args: dict[str, Any] = {"url": url}
        if background:
            args["background"] = True
        result = await self.call_tool("new_page", args)
        pages = parse_page_list(tool_result_text(result))
        created_page = next(
            (page for page in pages if page["pageId"] not in before_page_ids),
            None,
        )
        if created_page is None:
            created_page = next(
                (
                    page
                    for page in pages
                    if page.get("selected") and page.get("url") == url
                ),
                None,
            )
        if created_page is None:
            created_page = next((page for page in pages if page.get("url") == url), None)
        if created_page is None and pages:
            created_page = pages[-1]
        if created_page is None:
            raise RuntimeError("Chrome DevTools MCP did not report the opened page")
        return created_page

    async def navigate_page(self, page_id: int, url: str) -> None:
        await self.select_page(page_id, True)
        await self.call_tool(
            "navigate_page",
            {
                "type": "url",
                "url": url,
                "timeout": 15000,
            },
        )

    async def close_page(self, page_id: int) -> None:
        await self.call_tool("close_page", {"pageId": page_id})

    async def health(self) -> dict[str, Any]:
        pages = await self.list_pages()
        return {
            "connected": True,
            "pageCount": len(pages),
        }

    async def navigate_to_url(self, payload: dict[str, Any]) -> dict[str, Any]:
        target_url = str(payload.get("targetUrl") or "").strip()
        current_page_url = str(payload.get("currentPageUrl") or "").strip()
        target_label = str(payload.get("targetLabel") or "").strip() or None

        if not target_url:
            raise RuntimeError("targetUrl is required")

        current_page = (
            await self.find_page_by_url(current_page_url)
            if current_page_url
            else None
        )
        if current_page:
            await self.navigate_page(current_page["pageId"], target_url)
            await self.wait_for_page_ready(current_page["pageId"], 15000)
            return {
                "summary": (
                    f"Opened LinkedIn search results for {target_label}."
                    if target_label
                    else "Opened the requested page."
                ),
                "metadata": {
                    "kind": "navigate_to_url",
                    "pageId": current_page["pageId"],
                    "targetUrl": target_url,
                    "reusedPage": True,
                },
            }

        existing_target_page = await self.find_page_by_url(target_url)
        if existing_target_page:
            await self.select_page(existing_target_page["pageId"], True)
            return {
                "summary": (
                    f"Focused LinkedIn search results for {target_label}."
                    if target_label
                    else "Focused the requested page."
                ),
                "metadata": {
                    "kind": "navigate_to_url",
                    "pageId": existing_target_page["pageId"],
                    "targetUrl": target_url,
                    "reusedPage": True,
                },
            }

        page = await self.open_page(target_url)
        await self.wait_for_page_ready(page["pageId"], 15000)
        return {
            "summary": (
                f"Opened LinkedIn search results for {target_label}."
                if target_label
                else "Opened the requested page."
            ),
            "metadata": {
                "kind": "navigate_to_url",
                "pageId": page["pageId"],
                "targetUrl": target_url,
                "reusedPage": False,
            },
        }

    async def insert_draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        page_url = str(payload.get("pageUrl") or "").strip()
        field_target = payload.get("fieldTarget")
        generated_text = str(payload.get("generatedText") or "")
        verify_text = str(payload.get("verifyText") or "")
        target_name = payload.get("targetName")

        if not page_url:
            raise RuntimeError("pageUrl is required")
        if not isinstance(field_target, dict):
            raise RuntimeError("fieldTarget is required")
        selector = str(field_target.get("selector") or "").strip()
        if not selector:
            raise RuntimeError("fieldTarget.selector is required")

        page = await self.find_page_by_url(page_url)
        if not page:
            raise RuntimeError(
                "The approved page is not open in Chrome DevTools MCP. Keep the target page open and try again."
            )

        inserted = await self.evaluate_on_page(
            page_id=page["pageId"],
            function_source=build_function_source(
                self.bundle["executeInsertTextBySelectorInPage"]
            ),
            args=[
                selector,
                generated_text,
                field_target.get("platform"),
            ],
            bring_to_front=True,
        )
        if not inserted:
            raise RuntimeError("Failed to insert the approved draft into the target field")

        verified = await self.evaluate_on_page(
            page_id=page["pageId"],
            function_source=VERIFY_INSERT_FUNCTION,
            args=[selector, verify_text],
            bring_to_front=True,
        )
        if not verified:
            raise RuntimeError("Inserted draft could not be verified in the target field")

        summary = (
            f"Inserted the approved draft for {target_name}."
            if isinstance(target_name, str) and target_name.strip()
            else "Inserted the approved draft into the active field."
        )
        return {
            "summary": summary,
            "metadata": {
                "kind": "insert_draft",
                "selector": selector,
                "pageUrl": page_url,
            },
        }

    async def execute_linkedin_connect_batch(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        raw_items = payload.get("items")
        daily_limit = payload.get("dailyLimit")
        if not isinstance(raw_items, list) or not raw_items:
            raise RuntimeError("items are required")

        max_items = max(
            1,
            min(
                len(raw_items),
                round(daily_limit if isinstance(daily_limit, (int, float)) else len(raw_items)),
            ),
        )
        items = raw_items[:max_items]
        sent = 0
        skipped = 0
        failed = 0
        final_states: list[str] = []

        for item in items:
            if not isinstance(item, dict):
                continue
            result = await self.execute_linkedin_connect_item(item, {})
            final_states.append(result["finalState"])
            if result["outcome"] == "sent":
                sent += 1
            elif result["outcome"] == "skipped":
                skipped += 1
            else:
                failed += 1
            await asyncio.sleep(human_delay(2200) / 1000)

        summary_parts = [
            f"LinkedIn connect batch finished for {len(items)} target{'s' if len(items) != 1 else ''}.",
            f"Sent: {sent}.",
        ]
        if skipped > 0:
            summary_parts.append(f"Skipped: {skipped}.")
        if failed > 0:
            summary_parts.append(f"Failed: {failed}.")

        return {
            "summary": " ".join(summary_parts),
            "metadata": {
                "kind": "execute_task_batch",
                "batchType": "linkedin_connect",
                "itemCount": len(items),
                "sent": sent,
                "skipped": skipped,
                "failed": failed,
                "finalStates": final_states,
            },
        }

    async def execute_linkedin_connect_item(
        self, item: dict[str, Any], dom_hints: dict[str, Any]
    ) -> dict[str, Any]:
        target_url = str(item.get("targetUrl") or "").strip()
        target_name = str(item.get("targetName") or "").strip() or None
        message = str(item.get("generatedText") or "").strip()
        if not target_url:
            raise RuntimeError("LinkedIn batch item targetUrl is required")

        page = await self.open_page(target_url)
        preserve_page = False

        try:
            await self.wait_for_page_ready(page["pageId"], 15000)
            await asyncio.sleep(human_delay(1200) / 1000)

            action_probe = await self.evaluate_on_page(
                page_id=page["pageId"],
                function_source=build_function_source(
                    self.bundle["executeWaitForLinkedInPrimaryActionsInPage"]
                ),
                args=[9000, dom_hints],
            )
            preflight_labels = (
                action_probe.get("labels")
                if isinstance(action_probe, dict) and isinstance(action_probe.get("labels"), list)
                else []
            )

            connect_flow = await self.evaluate_on_page(
                page_id=page["pageId"],
                function_source=build_function_source(
                    self.bundle["executeLinkedInConnectWorkflowInPage"],
                    {
                        "isBackgroundTabLayoutUnavailable": self.bundle[
                            "isBackgroundTabLayoutUnavailable"
                        ],
                        "isLinkedInAddNoteText": self.bundle["isLinkedInAddNoteText"],
                        "isLinkedInSendText": self.bundle["isLinkedInSendText"],
                        "isLinkedInFinalSendText": self.bundle[
                            "isLinkedInFinalSendText"
                        ],
                    },
                ),
                args=[message, dom_hints],
            )

            final_state = (
                str(connect_flow.get("state"))
                if isinstance(connect_flow, dict) and connect_flow.get("state") is not None
                else "dialog_not_found"
            )

            if should_retry_linkedin_connect_with_custom_invite(final_state):
                custom_invite_url = build_linkedin_custom_invite_url(target_url)
                if custom_invite_url:
                    await self.navigate_page(page["pageId"], custom_invite_url)
                    await asyncio.sleep(human_delay(900) / 1000)
                    connect_flow = await self.evaluate_on_page(
                        page_id=page["pageId"],
                        function_source=build_function_source(
                            self.bundle["executeLinkedInConnectWorkflowInPage"],
                            {
                                "isBackgroundTabLayoutUnavailable": self.bundle[
                                    "isBackgroundTabLayoutUnavailable"
                                ],
                                "isLinkedInAddNoteText": self.bundle[
                                    "isLinkedInAddNoteText"
                                ],
                                "isLinkedInSendText": self.bundle["isLinkedInSendText"],
                                "isLinkedInFinalSendText": self.bundle[
                                    "isLinkedInFinalSendText"
                                ],
                            },
                        ),
                        args=[message, dom_hints],
                    )
                    final_state = (
                        str(connect_flow.get("state"))
                        if isinstance(connect_flow, dict)
                        and connect_flow.get("state") is not None
                        else "dialog_not_found"
                    )

            debug_summary = summarize_linkedin_connect_debug(connect_flow) or (
                f"preflight={', '.join(str(label) for label in preflight_labels[:8])}"
                if preflight_labels
                else None
            )

            if final_state in {"already_connected", "already_pending"}:
                return {
                    "outcome": "skipped",
                    "finalState": final_state,
                    "debugSummary": debug_summary,
                    "preservedPage": False,
                }

            if final_state == "sent":
                return {
                    "outcome": "sent",
                    "finalState": final_state,
                    "debugSummary": debug_summary,
                    "preservedPage": False,
                }

            preserve_page = final_state in {
                "dialog_not_found",
                "note_editor_not_found",
                "send_not_found",
            }

            return {
                "outcome": (
                    "skipped"
                    if final_state in {"no_connect_control", "menu_connect_not_found"}
                    else "failed"
                ),
                "finalState": final_state,
                "debugSummary": debug_summary,
                "preservedPage": preserve_page,
            }
        finally:
            if not preserve_page:
                try:
                    await self.close_page(page["pageId"])
                except Exception:
                    pass


async def run_runtime() -> None:
    cwd = os.getenv("MCP_AGENT_BRIDGE_CWD", "").strip() or os.getcwd()
    bundle = load_browser_control_bundle(cwd)
    app = MCPApp(
        name="cheatresume_python_browser_runtime",
        settings=build_settings(),
    )

    async with app.run():
        agent = Agent(
            name="chrome_runtime",
            server_names=["chrome-devtools"],
            context=app.context,
        )

        async with agent:
            runtime = PythonBrowserRuntime(agent, bundle)
            while True:
                raw_line = await read_request_line()
                if raw_line == "":
                    return

                line = raw_line.strip()
                if not line:
                    continue

                request_id = "unknown"
                try:
                    request = json.loads(line)
                    request_id = str(request.get("id", "unknown"))
                    method = request.get("method")
                    args = request.get("args")
                    if not isinstance(args, dict):
                        args = {}

                    if method == "shutdown":
                        write_response({"id": request_id, "ok": True, "result": {"ok": True}})
                        return

                    if method == "health":
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_result(await runtime.health()),
                            }
                        )
                        continue

                    if method == "navigate_to_url":
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_result(
                                    await runtime.navigate_to_url(args)
                                ),
                            }
                        )
                        continue

                    if method == "insert_draft":
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_result(
                                    await runtime.insert_draft(args)
                                ),
                            }
                        )
                        continue

                    if method == "execute_linkedin_connect_batch":
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_result(
                                    await runtime.execute_linkedin_connect_batch(args)
                                ),
                            }
                        )
                        continue

                    raise ValueError(f"Unsupported runtime method: {method}")
                except Exception as error:
                    write_response(
                        {
                            "id": request_id,
                            "ok": False,
                            "error": normalize_error_message(error),
                        }
                    )


def main() -> None:
    try:
        asyncio.run(run_runtime())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
