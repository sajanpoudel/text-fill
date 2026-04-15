#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import sys
from typing import Any
from urllib.parse import urlparse

from mcp_agent.agents.agent import Agent
from mcp_agent.app import MCPApp
from mcp_agent.config import (
    AnthropicSettings,
    GoogleSettings,
    LoggerSettings,
    MCPServerSettings,
    MCPSettings,
    OpenAISettings,
    Settings,
)
from mcp_agent.workflows.llm.augmented_llm import RequestParams
from mcp_agent.workflows.llm.augmented_llm_anthropic import AnthropicAugmentedLLM
from mcp_agent.workflows.llm.augmented_llm_google import GoogleAugmentedLLM
from mcp_agent.workflows.llm.augmented_llm_openai import OpenAIAugmentedLLM


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


BASE_AGENT_SYSTEM_PROMPT = """
You are a browser control agent operating only through Chrome DevTools MCP tools.
Always inspect the current page tree with take_snapshot before clicking or typing.
Prefer built-in browser tools such as list_pages, select_page, new_page, navigate_page,
take_snapshot, click, fill, fill_form, type_text, press_key, wait_for, and close_page.
Use evaluate_script only when a built-in tool cannot complete verification or the page
requires a capability the built-in tools do not provide.
When the user's goal explicitly asks you to fill, submit, search, navigate, click, send,
connect, or otherwise complete an on-page task, perform that task instead of stopping at a plan.
Avoid destructive billing, account-security, or data-deletion actions unless the user explicitly asked for them.
Never claim success unless you verified it from the live browser state.
Return only compact JSON that matches the requested schema. Do not return markdown.
""".strip()


def build_effective_system_prompt(base_prompt: str, custom_prompt: str | None) -> str:
    trimmed = str(custom_prompt or "").strip()
    if not trimmed:
        return base_prompt
    return "\n\n".join(
        [
            base_prompt,
            "Additional saved user instructions:",
            trimmed,
        ]
    )


def log_runtime(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


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
        if current.scheme != target.scheme or current.netloc != target.netloc:
            return False
        return current.path.startswith(target.path)
    except Exception:
        return page_url == target_url


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


async def read_request_line() -> str:
    return await asyncio.to_thread(sys.stdin.readline)


def write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def truncate_text(value: str, max_length: int) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= max_length:
        return normalized
    return normalized[: max_length - 1].rstrip() + "…"


def summarize_json_value(value: Any, max_length: int = 400) -> str:
    try:
        serialized = json.dumps(serialize_result(value), ensure_ascii=True)
    except Exception:
        serialized = repr(value)
    return truncate_text(serialized, max_length)


def extract_json_payload(text: str) -> dict[str, Any]:
    candidates: list[str] = [text.strip()]
    candidates.extend(
        match.strip()
        for match in re.findall(r"```json\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    )

    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start >= 0 and brace_end > brace_start:
        candidates.append(text[brace_start : brace_end + 1].strip())

    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed

    raise RuntimeError(
        "The browser agent returned a response that was not valid JSON."
    )


def build_json_finalization_prompt(
    *,
    task_label: str,
    original_response: str,
    page_url: str | None,
    page_title: str | None,
    page_snapshot: str | None,
) -> str:
    parts = [
        "The browser task already ran, but the agent did not return valid final JSON.",
        "Your only job now is to produce the final JSON result.",
        "",
        "Constraints:",
        "- Do not call tools.",
        "- Do not continue browsing.",
        "- Return JSON only.",
        "- Use the live page state included below to infer the final status as accurately as possible.",
        "- If the task appears incomplete or blocked, set status to failed and say why.",
        "",
        f"Task label: {task_label}",
        f"Original agent response: {json.dumps(original_response or '', ensure_ascii=True)}",
    ]

    if page_url:
        parts.append(f"Current page URL: {page_url}")
    if page_title:
        parts.append(f"Current page title: {page_title}")
    if page_snapshot:
        parts.extend(["", "Current page snapshot:", truncate_text(page_snapshot, 6000)])

    parts.extend(
        [
            "",
            'Return JSON: {"summary":"...", "status":"completed|failed", "finalUrl":"optional", "notes":["optional"]}',
        ]
    )
    return "\n".join(parts)


def normalize_provider_name(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized in {"google", "gemini"}:
        return "gemini"
    if normalized not in {"openai", "anthropic", "gemini"}:
        raise RuntimeError(f"Unsupported provider for mcp-agent runtime: {provider}")
    return normalized


def build_general_task_prompt(payload: dict[str, Any]) -> str:
    parts = [
        "Task:",
        str(payload.get("goal") or "").strip(),
        "",
        "Constraints:",
        "- Use Chrome DevTools MCP tools only.",
        "- Complete the requested browser task end-to-end when the goal is explicit.",
        "- You may click, type, fill, submit, send, connect, search, and navigate when needed to satisfy the goal.",
        "- Do not perform billing, password, account-deletion, or irreversible security actions unless the user explicitly asked for them.",
        "- Prefer the current page if it matches the task. You may navigate or open pages when needed.",
        "- Use take_snapshot to inspect the page tree before interacting.",
        "- Verify the result from the live page before finishing.",
    ]

    page_url = str(payload.get("pageUrl") or "").strip()
    if page_url:
        parts.extend(["", f"Current page URL: {page_url}"])

    platform_hint = str(payload.get("platformHint") or "").strip()
    if platform_hint:
        parts.append(f"Platform hint: {platform_hint}")

    page_context = str(payload.get("pageContext") or "").strip()
    if page_context:
        parts.extend(["", "Observed page context:", page_context[:4000]])

    user_context = str(payload.get("userContext") or "").strip()
    if user_context:
        parts.extend(["", "User-specific context:", user_context[:4000]])

    field_target = payload.get("fieldTarget")
    if isinstance(field_target, dict):
        selector = str(field_target.get("selector") or "").strip()
        if selector:
            parts.extend(["", f"Known field selector: {selector}"])

    structured = payload.get("structured")
    if isinstance(structured, dict) and structured:
        parts.extend(
            [
                "",
                "Structured observation:",
                truncate_text(json.dumps(structured, ensure_ascii=True), 2500),
            ]
        )

    scanned_candidates = payload.get("scannedCandidates")
    if isinstance(scanned_candidates, list) and scanned_candidates:
        parts.extend(
            [
                "",
                "Candidate scan hints:",
                truncate_text(json.dumps(scanned_candidates[:8], ensure_ascii=True), 2000),
            ]
        )

    parts.extend(
        [
            "",
            'Return JSON: {"summary":"...", "status":"completed|failed", "finalUrl":"optional", "notes":["optional"]}',
        ]
    )
    return "\n".join(parts)


def build_insert_draft_prompt(payload: dict[str, Any]) -> str:
    return "\n".join(
        [
            "Insert the approved draft into the open page.",
            "",
            "Constraints:",
            "- Use Chrome DevTools MCP tools only.",
            "- Use take_snapshot to inspect the page tree before interacting.",
            "- Target the page that matches the provided URL and the field that best matches the provided selector.",
            "- Insert the exact draft text, preserving line breaks.",
            "- Do not submit, send, or trigger any irreversible action.",
            "- Verify that the field contains the verification text before returning success.",
            "",
            f'Page URL: {str(payload.get("pageUrl") or "").strip()}',
            f'Field selector: {str(payload.get("selector") or "").strip()}',
            f'Draft text: {json.dumps(str(payload.get("generatedText") or ""), ensure_ascii=True)}',
            f'Verification text: {json.dumps(str(payload.get("verifyText") or ""), ensure_ascii=True)}',
            "",
            'Return JSON: {"summary":"...", "status":"completed|failed", "verified":true|false}',
        ]
    )


def build_linkedin_connect_prompt(item: dict[str, Any]) -> str:
    note_text = str(item.get("generatedText") or "").strip()
    target_url = str(item.get("targetUrl") or "").strip()
    target_name = str(item.get("targetName") or "").strip() or "the target profile"
    goal = str(item.get("goal") or "").strip()
    page_context = str(item.get("pageContext") or "").strip()
    user_context = str(item.get("userContext") or "").strip()
    return "\n".join(
        [
            "Send a LinkedIn connection request on the focused profile page.",
            "",
            "Constraints:",
            "- Use Chrome DevTools MCP tools only.",
            "- Use take_snapshot to inspect the page tree before interacting.",
            "- Confirm whether the profile is already connected or already pending before sending anything.",
            "- If note text is provided, add that exact note text.",
            "- If note text is empty and the goal requests a note, draft a concise note of 300 characters or less.",
            "- When drafting a note, use only the provided user context plus visible profile information. Do not invent personal facts that are not in the supplied context.",
            "- After acting, verify the final page state from the live browser before returning.",
            "- If the flow becomes ambiguous or blocked, stop and report failure instead of guessing.",
            "",
            f"Target profile URL: {target_url}",
            f"Target name: {target_name}",
            f"Note text: {json.dumps(note_text, ensure_ascii=True)}",
            *(["", f"Original goal: {goal}"] if goal else []),
            *(["", f"Observed page context: {page_context[:2500]}"] if page_context else []),
            *(["", f"User context: {user_context[:2500]}"] if user_context else []),
            "",
            'Return JSON: {"summary":"...", "status":"sent|skipped|failed", "finalState":"sent|already_connected|already_pending|connect_not_found|failed", "preservePage":true|false}',
        ]
    )


def is_linkedin_profile_connect_goal(payload: dict[str, Any]) -> bool:
    goal = str(payload.get("goal") or "").strip().lower()
    platform_hint = str(payload.get("platformHint") or "").strip().lower()
    page_url = str(payload.get("pageUrl") or "").strip().lower()

    if not goal:
        return False

    is_linkedin = platform_hint == "linkedin" or "linkedin.com" in page_url
    is_profile = "/linkedin.com/in/" in page_url or "linkedin.com/in/" in page_url
    wants_connect = any(
        phrase in goal
        for phrase in (
            "connect",
            "connection request",
            "invite",
            "add a note",
            "connection note",
        )
    )
    return is_linkedin and is_profile and wants_connect


def extract_linkedin_target_name(payload: dict[str, Any]) -> str | None:
    structured = payload.get("structured")
    if isinstance(structured, dict):
        data = structured.get("data")
        if isinstance(data, dict):
            for key in ("name", "title"):
                value = str(data.get(key) or "").strip()
                if value:
                    return value

    page_context = str(payload.get("pageContext") or "").strip()
    match = re.search(r"Page:\s*([^\n]+)", page_context)
    if match:
        value = match.group(1).strip()
        if value:
            return value

    return None


class PythonBrowserRuntime:
    def __init__(self, agent: Agent):
        self.agent = agent

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        trace: bool = True,
    ) -> Any:
        if trace:
            log_runtime(
                f"[mcp-tool] start name={name} args={summarize_json_value(args or {})}"
            )
        result = await self.agent.call_tool(
            name,
            args or {},
            server_name="chrome-devtools",
        )
        if trace:
            result_text = tool_result_text(result).strip()
            log_runtime(
                f"[mcp-tool] complete name={name} result={truncate_text(result_text, 500) if result_text else '<no-text>'}"
            )
        if is_tool_error(result):
            message = tool_result_text(result).strip()
            raise RuntimeError(message or f"Chrome DevTools MCP tool failed: {name}")
        return result

    async def list_pages(self, *, trace: bool = True) -> list[dict[str, Any]]:
        result = await self.call_tool("list_pages", trace=trace)
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

    async def capture_selected_page_state(self) -> dict[str, Any]:
        pages = await self.list_pages()
        page = next((candidate for candidate in pages if candidate.get("selected")), None)
        if page is None and pages:
            page = pages[0]
        if page is None:
            return {}

        page_id = int(page["pageId"])
        state: dict[str, Any] = {
            "pageId": page_id,
            "pageUrl": str(page.get("url") or "").strip() or None,
        }

        try:
            await self.select_page(page_id, True)
        except Exception:
            return state

        try:
            page_title = await self.evaluate_on_page(
                page_id=page_id,
                function_source="() => document.title || ''",
            )
            if isinstance(page_title, str) and page_title.strip():
                state["pageTitle"] = page_title.strip()
        except Exception:
            pass

        try:
            snapshot_result = await self.call_tool("take_snapshot")
            snapshot_text = tool_result_text(snapshot_result).strip()
            if snapshot_text:
                state["pageSnapshot"] = snapshot_text
        except Exception:
            pass

        if "pageSnapshot" not in state:
            try:
                visible_text = await self.evaluate_on_page(
                    page_id=page_id,
                    function_source=(
                        "() => (document.body?.innerText || document.documentElement?.innerText || '').slice(0, 4000)"
                    ),
                )
                if isinstance(visible_text, str) and visible_text.strip():
                    state["pageSnapshot"] = visible_text.strip()
            except Exception:
                pass

        return state

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

    async def focus_or_open_page(self, page_url: str) -> dict[str, Any]:
        page = await self.find_page_by_url(page_url)
        if page:
            await self.select_page(page["pageId"], True)
            return page
        page = await self.open_page(page_url)
        await self.wait_for_page_ready(page["pageId"], 15000)
        return page

    async def attach_augmented_llm(
        self, provider_config: dict[str, Any], instruction: str
    ) -> tuple[Any, str, str]:
        provider = normalize_provider_name(str(provider_config.get("provider") or "openai"))
        api_key = str(provider_config.get("apiKey") or "").strip()
        model = str(provider_config.get("model") or "").strip()

        if not api_key:
            raise RuntimeError(
                "Missing API key for the configured provider. Add it in Settings before running browser tasks."
            )

        self.agent.instruction = instruction

        if provider == "openai":
            self.agent.context.config.openai = OpenAISettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await self.agent.attach_llm(llm_factory=OpenAIAugmentedLLM)
        elif provider == "anthropic":
            self.agent.context.config.anthropic = AnthropicSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await self.agent.attach_llm(llm_factory=AnthropicAugmentedLLM)
        else:
            self.agent.context.config.google = GoogleSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await self.agent.attach_llm(llm_factory=GoogleAugmentedLLM)

        llm.instruction = instruction
        return llm, provider, model

    async def run_agent_json_task(
        self,
        *,
        provider_config: dict[str, Any],
        task_label: str,
        system_prompt: str,
        user_prompt: str,
        max_iterations: int,
        max_tokens: int,
    ) -> dict[str, Any]:
        llm, provider, model = await self.attach_augmented_llm(
            provider_config,
            system_prompt,
        )
        log_runtime(
            f"[agent-task] start label={task_label} provider={provider} model={model or 'default'}"
        )
        response_text = await llm.generate_str(
            user_prompt,
            RequestParams(
                model=model or None,
                max_iterations=max_iterations,
                maxTokens=max_tokens,
                temperature=0.1,
                use_history=False,
                reasoning_effort="medium" if provider == "openai" else None,
            ),
        )
        log_runtime(
            f"[agent-task] complete label={task_label} response={truncate_text(response_text, 400)}"
        )
        try:
            parsed = extract_json_payload(response_text)
        except RuntimeError:
            page_state = await self.capture_selected_page_state()
            log_runtime(
                f"[agent-task] finalize_json label={task_label} page_url={page_state.get('pageUrl') or ''}"
            )
            repair_prompt = build_json_finalization_prompt(
                task_label=task_label,
                original_response=response_text,
                page_url=(
                    str(page_state.get("pageUrl") or "").strip() or None
                ),
                page_title=(
                    str(page_state.get("pageTitle") or "").strip() or None
                ),
                page_snapshot=(
                    str(page_state.get("pageSnapshot") or "").strip() or None
                ),
            )
            repair_text = await llm.generate_str(
                repair_prompt,
                RequestParams(
                    model=model or None,
                    max_iterations=2,
                    maxTokens=min(900, max_tokens),
                    temperature=0,
                    use_history=False,
                    reasoning_effort="low" if provider == "openai" else None,
                ),
            )
            log_runtime(
                f"[agent-task] finalize_json_complete label={task_label} response={truncate_text(repair_text, 400)}"
            )
            parsed = extract_json_payload(repair_text)
            response_text = repair_text
        parsed["_rawResponse"] = response_text
        return parsed

    async def health(self) -> dict[str, Any]:
        pages = await self.list_pages(trace=False)
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
        target_name = str(payload.get("targetName") or "").strip() or None
        provider_config = payload.get("providerConfig")

        if not page_url:
            raise RuntimeError("pageUrl is required")
        if not isinstance(field_target, dict):
            raise RuntimeError("fieldTarget is required")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

        selector = str(field_target.get("selector") or "").strip()
        if not selector:
            raise RuntimeError("fieldTarget.selector is required")

        page = await self.find_page_by_url(page_url)
        if not page:
            raise RuntimeError(
                "The approved page is not open in Chrome DevTools MCP. Keep the target page open and try again."
            )

        await self.select_page(page["pageId"], True)
        agent_result = await self.run_agent_json_task(
            provider_config=provider_config,
            task_label="insert_draft",
            system_prompt=BASE_AGENT_SYSTEM_PROMPT,
            user_prompt=build_insert_draft_prompt(
                {
                    "pageUrl": page_url,
                    "selector": selector,
                    "generatedText": generated_text,
                    "verifyText": verify_text,
                }
            ),
            max_iterations=10,
            max_tokens=1200,
        )

        verified = await self.evaluate_on_page(
            page_id=page["pageId"],
            function_source=VERIFY_INSERT_FUNCTION,
            args=[selector, verify_text],
            bring_to_front=True,
        )
        if not verified:
            raise RuntimeError("Inserted draft could not be verified in the target field")

        summary = str(agent_result.get("summary") or "").strip() or (
            f"Inserted the approved draft for {target_name}."
            if target_name
            else "Inserted the approved draft into the active field."
        )
        return {
            "summary": summary,
            "metadata": {
                "kind": "insert_draft",
                "selector": selector,
                "pageUrl": page_url,
                "pageId": page["pageId"],
                "verified": True,
            },
        }

    async def execute_linkedin_connect_batch(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        raw_items = payload.get("items")
        daily_limit = payload.get("dailyLimit")
        provider_config = payload.get("providerConfig")
        if not isinstance(raw_items, list) or not raw_items:
            raise RuntimeError("items are required")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

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
            result = await self.execute_linkedin_connect_item(item, provider_config)
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
        self,
        item: dict[str, Any],
        provider_config: dict[str, Any],
    ) -> dict[str, Any]:
        target_url = str(item.get("targetUrl") or "").strip()
        if not target_url:
            raise RuntimeError("LinkedIn batch item targetUrl is required")

        page = await self.focus_or_open_page(target_url)
        preserve_page = False

        try:
            await self.wait_for_page_ready(page["pageId"], 15000)
            agent_result = await self.run_agent_json_task(
                provider_config=provider_config,
                task_label="linkedin_connect",
                system_prompt=build_effective_system_prompt(
                    BASE_AGENT_SYSTEM_PROMPT,
                    str(item.get("systemPrompt") or "").strip() or None,
                ),
                user_prompt=build_linkedin_connect_prompt(item),
                max_iterations=14,
                max_tokens=1400,
            )

            outcome = str(agent_result.get("status") or "").strip().lower() or "failed"
            if outcome not in {"sent", "skipped", "failed"}:
                outcome = "failed"

            final_state = (
                str(agent_result.get("finalState") or "").strip() or outcome
            )
            preserve_page = bool(agent_result.get("preservePage"))
            summary = str(agent_result.get("summary") or "").strip()
            if not summary:
                if outcome == "sent":
                    summary = f"Sent a LinkedIn connection request to {str(item.get('targetName') or 'the target profile').strip() or 'the target profile'}."
                elif final_state == "already_connected":
                    summary = "This LinkedIn profile is already connected."
                elif final_state == "already_pending":
                    summary = "A LinkedIn invitation is already pending for this profile."
                else:
                    summary = f"LinkedIn connect flow ended in state: {final_state}."

            return {
                "outcome": outcome,
                "finalState": final_state,
                "summary": summary,
                "debugSummary": truncate_text(
                    str(agent_result.get("_rawResponse") or ""), 300
                ),
                "preservedPage": preserve_page,
            }
        finally:
            if not preserve_page:
                try:
                    await self.close_page(page["pageId"])
                except Exception:
                    pass

    async def execute_agent_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        provider_config = payload.get("providerConfig")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

        if is_linkedin_profile_connect_goal(payload):
            target_url = str(payload.get("pageUrl") or "").strip()
            if not target_url:
                raise RuntimeError("A LinkedIn profile URL is required for connect tasks.")
            connect_result = await self.execute_linkedin_connect_item(
                {
                    "targetUrl": target_url,
                    "targetName": extract_linkedin_target_name(payload),
                    "goal": str(payload.get("goal") or "").strip(),
                    "pageContext": str(payload.get("pageContext") or "").strip(),
                    "userContext": str(payload.get("userContext") or "").strip(),
                    "systemPrompt": str(payload.get("systemPrompt") or "").strip(),
                },
                provider_config,
            )
            if connect_result["outcome"] == "failed":
                raise RuntimeError(connect_result["summary"])

            return {
                "summary": connect_result["summary"],
                "metadata": {
                    "kind": "execute_agent_task",
                    "taskType": "linkedin_profile_connect",
                    "finalState": connect_result["finalState"],
                    "status": connect_result["outcome"],
                    "targetUrl": target_url,
                    "preservedPage": connect_result["preservedPage"],
                },
            }

        page_url = str(payload.get("pageUrl") or "").strip()
        focused_page: dict[str, Any] | None = None
        if page_url:
            focused_page = await self.focus_or_open_page(page_url)
            await self.wait_for_page_ready(focused_page["pageId"], 15000)

        agent_result = await self.run_agent_json_task(
            provider_config=provider_config,
            task_label="generic_browser_task",
            system_prompt=build_effective_system_prompt(
                BASE_AGENT_SYSTEM_PROMPT,
                str(payload.get("systemPrompt") or "").strip() or None,
            ),
            user_prompt=build_general_task_prompt(payload),
            max_iterations=12,
            max_tokens=1400,
        )

        status = str(agent_result.get("status") or "").strip().lower() or "failed"
        summary = str(agent_result.get("summary") or "").strip()
        if not summary:
            summary = "The Chrome MCP agent finished without returning a usable summary."

        if status == "failed":
            raise RuntimeError(summary)

        metadata: dict[str, Any] = {
            "kind": "execute_agent_task",
            "status": status,
        }
        if focused_page:
            metadata["pageId"] = focused_page["pageId"]
        final_url = str(agent_result.get("finalUrl") or "").strip()
        if final_url:
            metadata["finalUrl"] = final_url

        return {
            "summary": summary,
            "metadata": metadata,
        }


async def run_runtime() -> None:
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
            runtime = PythonBrowserRuntime(agent)
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
                                "result": serialize_result(await runtime.insert_draft(args)),
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

                    if method == "execute_agent_task":
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_result(
                                    await runtime.execute_agent_task(args)
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
