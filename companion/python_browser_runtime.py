#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager, suppress
import json
import math
import os
import random
import re
import sys
import tempfile
import uuid
from typing import Any
from urllib.parse import urlparse

from mcp_agent.agents.agent import Agent, AgentTasks
from mcp_agent.app import MCPApp
from mcp_agent.config import (
    AnthropicSettings,
    GoogleSettings,
    LoggerSettings,
    MCPServerSettings,
    MCPSettings,
    OpenAISettings,
    Settings,
    TemporalSettings,
)
from mcp_agent.executor import temporal as temporal_executor
from mcp_agent.executor.temporal import (
    ContextPropagationInterceptor,
    SystemActivities,
    TemporalExecutor,
    Worker,
)
from mcp_agent.workflows.llm.augmented_llm import RequestParams
from mcp_agent.workflows.llm.augmented_llm_anthropic import AnthropicAugmentedLLM
from mcp_agent.workflows.llm.augmented_llm_google import GoogleAugmentedLLM
from mcp_agent.workflows.llm.augmented_llm_openai import OpenAIAugmentedLLM
from mcp_agent.workflows.factory import (
    AgentSpec,
    OrchestratorOverrides,
    create_orchestrator,
)
from mcp_agent.executor.workflow import Workflow, WorkflowResult


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


def get_runtime_execution_engine() -> str:
    requested = (
        os.getenv("LOCAL_COMPANION_MCP_AGENT_EXECUTION_ENGINE", "").strip().lower()
        or os.getenv("MCP_AGENT_EXECUTION_ENGINE", "").strip().lower()
    )
    if requested == "temporal":
        return "temporal"
    return "asyncio"


def build_temporal_host() -> str:
    explicit_host = os.getenv("LOCAL_COMPANION_TEMPORAL_ADDRESS", "").strip()
    if explicit_host:
        return explicit_host

    host = os.getenv("LOCAL_COMPANION_TEMPORAL_HOST", "").strip() or "127.0.0.1"
    port = os.getenv("LOCAL_COMPANION_TEMPORAL_PORT", "").strip() or "7233"
    return f"{host}:{port}"


def build_settings() -> Settings:
    execution_engine = get_runtime_execution_engine()
    return build_runtime_settings(execution_engine)


def build_runtime_settings(execution_engine: str) -> Settings:
    cwd = os.getenv("MCP_AGENT_BRIDGE_CWD", "").strip() or os.getcwd()
    command = os.getenv("CHROME_DEVTOOLS_MCP_COMMAND", "").strip() or "npx"
    allowed_env = {
        key: value for key, value in os.environ.items() if isinstance(value, str)
    }

    settings = Settings(
        name="cheatresume_python_browser_runtime",
        execution_engine=execution_engine,
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
    if execution_engine == "temporal":
        settings.temporal = TemporalSettings(
            host=build_temporal_host(),
            namespace=(
                os.getenv("LOCAL_COMPANION_TEMPORAL_NAMESPACE", "").strip()
                or "default"
            ),
            task_queue=(
                os.getenv("LOCAL_COMPANION_TEMPORAL_TASK_QUEUE", "").strip()
                or "cheatresume-browser-agent"
            ),
            workflow_task_modules=[],
        )
    return settings


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


def write_resume_to_temp(resume_file: dict[str, Any]) -> str | None:
    """
    Decode base64 resume data and write to a named temp file.
    Returns the file path, or None if the data is missing/invalid.
    The caller is responsible for deleting the file when done.
    """
    try:
        raw_b64 = str(resume_file.get("base64") or "").strip()
        name = str(resume_file.get("name") or "resume").strip()
        if not raw_b64:
            return None
        file_bytes = base64.b64decode(raw_b64)
        suffix = os.path.splitext(name)[1] or ".pdf"
        # delete=False so the file persists until the agent is done
        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, prefix="cheatresume_"
        )
        tmp.write(file_bytes)
        tmp.flush()
        tmp.close()
        return tmp.name
    except Exception:
        return None


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

    resume_context = str(payload.get("resumeContext") or "").strip()
    if resume_context:
        parts.extend(["", "Continuation context:", resume_context[:4000]])

    site_experience_context = str(payload.get("siteExperienceContext") or "").strip()
    if site_experience_context:
        parts.extend(["", "What has worked on similar pages before:", site_experience_context[:4000]])

    user_context = str(payload.get("userContext") or "").strip()
    if user_context:
        parts.extend(["", "User-specific context:", user_context[:4000]])

    current_work_item = payload.get("currentWorkItem")
    if isinstance(current_work_item, dict) and current_work_item:
        work_item_lines: list[str] = []
        work_item_title = str(current_work_item.get("title") or "").strip()
        if work_item_title:
            work_item_lines.append(f"Work item: {work_item_title}")
        work_item_goal = str(current_work_item.get("itemGoal") or "").strip()
        if work_item_goal:
            work_item_lines.append(f"Item goal: {work_item_goal}")
        work_item_target = str(
            current_work_item.get("targetName")
            or current_work_item.get("targetUrl")
            or current_work_item.get("pageUrl")
            or ""
        ).strip()
        if work_item_target:
            work_item_lines.append(f"Target: {work_item_target}")
        work_item_context = str(current_work_item.get("itemContext") or "").strip()
        if work_item_context:
            work_item_lines.append(truncate_text(work_item_context, 2500))
        if work_item_lines:
            parts.extend(["", "Current queued work item:", *work_item_lines])

    # Resume file attachment — write to temp and pass path to agent
    resume_file = payload.get("resumeFile")
    if isinstance(resume_file, dict) and resume_file.get("base64"):
        resume_tmp_path = write_resume_to_temp(resume_file)
        if resume_tmp_path:
            resume_name = str(resume_file.get("name") or "resume.pdf").strip()
            parts.extend([
                "",
                "=== Resume File ===",
                f"The user's resume has been saved to a temporary file at: {resume_tmp_path}",
                f"Original filename: {resume_name}",
                "When you encounter a file upload input asking for a resume (e.g. input[type='file']), "
                "use the Chrome DevTools 'set_file_input_files' tool (or equivalent CDP method) "
                f"with the path '{resume_tmp_path}' to attach the file.",
                "Alternatively, use evaluate_script with this JavaScript to attach the resume programmatically:",
                "(async () => {",
                "  const input = document.querySelector('input[type=\"file\"]');",
                "  if (!input) return 'No file input found';",
                f"  const response = await fetch('file://{resume_tmp_path}');",
                "  const blob = await response.blob();",
                f"  const file = new File([blob], '{resume_name}', {{ type: blob.type }});",
                "  const dt = new DataTransfer(); dt.items.add(file);",
                "  Object.defineProperty(input, 'files', { value: dt.files, writable: true });",
                "  input.dispatchEvent(new Event('change', { bubbles: true }));",
                "  return 'Resume attached';",
                "})();",
            ])

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
            'Return JSON: {"summary":"...", "status":"completed|skipped|failed", "finalUrl":"optional", "notes":["optional"]}',
        ]
    )
    return "\n".join(parts)


def build_work_item_discovery_prompt(payload: dict[str, Any]) -> str:
    parts = [
        "Analyze the live browser page and determine whether the user's goal should run as a durable queue of repeated work items or as a single browser task.",
        "",
        "Constraints:",
        "- Use Chrome DevTools MCP tools only.",
        "- Inspect the live page tree with take_snapshot before deciding.",
        "- Prefer durable repeated items only when the page clearly exposes multiple similar actionable targets relevant to the goal.",
        "- Do not invent targets that are not visible on the live page.",
        "- Each work item should be stable enough to resume later. Prefer item-specific URLs when available; otherwise include strong itemContext.",
        "- If the page is not clearly a repeated-item workflow, return mode single and an empty workItems array.",
        "- Return JSON only.",
        "",
        f"Goal: {str(payload.get('goal') or '').strip()}",
    ]

    page_url = str(payload.get("pageUrl") or "").strip()
    if page_url:
        parts.append(f"Current page URL: {page_url}")

    platform_hint = str(payload.get("platformHint") or "").strip()
    if platform_hint:
        parts.append(f"Platform hint: {platform_hint}")

    page_context = str(payload.get("pageContext") or "").strip()
    if page_context:
        parts.extend(["", "Observed page context:", truncate_text(page_context, 4000)])

    site_experience_context = str(payload.get("siteExperienceContext") or "").strip()
    if site_experience_context:
        parts.extend(
            [
                "",
                "Prior site experience:",
                truncate_text(site_experience_context, 3000),
            ]
        )

    structured = payload.get("structured")
    if isinstance(structured, dict) and structured:
        parts.extend(
            [
                "",
                "Structured observation:",
                truncate_text(json.dumps(structured, ensure_ascii=True), 2500),
            ]
        )

    parts.extend(
        [
            "",
            'Return JSON: {"mode":"single|queue","summary":"...","workItems":[{"title":"...","pageUrl":"optional","targetName":"optional","itemGoal":"optional","itemContext":"optional","sourceType":"agent_discovered"}]}',
        ]
    )
    return "\n".join(parts)


def normalize_work_items(raw_items: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_items, list):
        return []

    items: list[dict[str, Any]] = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        page_url = str(raw_item.get("pageUrl") or raw_item.get("targetUrl") or "").strip()
        target_name = str(raw_item.get("targetName") or "").strip()
        item_goal = str(raw_item.get("itemGoal") or "").strip()
        item_context = str(raw_item.get("itemContext") or "").strip()
        source_type = str(raw_item.get("sourceType") or "agent_discovered").strip()

        if not title:
            if target_name:
                title = f"Handle {target_name}"
            elif page_url:
                title = f"Handle item {index + 1}"
            else:
                continue

        if not page_url and not item_context:
            continue

        items.append(
            {
                "title": title,
                **({"pageUrl": page_url, "targetUrl": page_url} if page_url else {}),
                **({"targetName": target_name} if target_name else {}),
                **({"itemGoal": item_goal} if item_goal else {}),
                **({"itemContext": item_context} if item_context else {}),
                "sourceType": source_type or "agent_discovered",
            }
        )
    return items


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
    resume_context = str(item.get("resumeContext") or "").strip()
    site_experience_context = str(item.get("siteExperienceContext") or "").strip()
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
            *(["", f"Continuation context: {resume_context[:2500]}"] if resume_context else []),
            *(["", f"Prior site experience: {site_experience_context[:2500]}"] if site_experience_context else []),
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


def coerce_generic_work_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = payload.get("workItems")
    if not isinstance(raw_items, list):
        return []

    items: list[dict[str, Any]] = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        page_url = str(raw_item.get("pageUrl") or raw_item.get("targetUrl") or "").strip()
        target_name = str(raw_item.get("targetName") or "").strip()
        item_goal = str(raw_item.get("itemGoal") or "").strip()
        item_context = str(raw_item.get("itemContext") or "").strip()
        if not title:
            if target_name:
                title = f"Handle {target_name}"
            elif page_url:
                title = f"Handle item {index + 1}"
            else:
                continue
        items.append(
            {
                "title": title,
                **({"pageUrl": page_url} if page_url else {}),
                **({"targetName": target_name} if target_name else {}),
                **({"itemGoal": item_goal} if item_goal else {}),
                **({"itemContext": item_context} if item_context else {}),
                **(
                    {"sourceType": str(raw_item.get("sourceType") or "").strip()}
                    if str(raw_item.get("sourceType") or "").strip()
                    else {}
                ),
            }
        )
    return items


def build_generic_queue_item_payload(
    payload: dict[str, Any], item: dict[str, Any]
) -> dict[str, Any]:
    item_payload = dict(payload)
    item_payload["currentWorkItem"] = item

    item_page_url = str(item.get("pageUrl") or item.get("targetUrl") or "").strip()
    if item_page_url:
        item_payload["pageUrl"] = item_page_url

    item_goal = str(item.get("itemGoal") or "").strip()
    if item_goal:
        item_payload["goal"] = item_goal

    item_context = str(item.get("itemContext") or "").strip()
    if item_context:
        existing_page_context = str(item_payload.get("pageContext") or "").strip()
        item_payload["pageContext"] = (
            f"{existing_page_context}\n\nQueued work item context:\n{item_context}"
            if existing_page_context
            else f"Queued work item context:\n{item_context}"
        )

    target_name = str(item.get("targetName") or "").strip()
    if target_name:
        item_payload["scannedCandidates"] = [
            {
                "targetName": target_name,
                "targetUrl": item_page_url,
            }
        ]

    return item_payload


def build_generic_orchestrator_overrides() -> OrchestratorOverrides:
    def get_task_prompt(objective: str, task: str, context: str) -> str:
        parts = [
            "You are the browser operator for one subtask of a larger browser goal.",
            "Use Chrome DevTools MCP tools only.",
            "Inspect the live page tree before interacting.",
            "Prefer reusing the current page or open tabs before opening new pages.",
            "Verify each meaningful action from the live browser state.",
            "If the current page already reflects completed work, do not repeat it.",
            "",
            f"Overall objective:\n{objective}",
            "",
            f"Assigned subtask:\n{task}",
        ]
        if context.strip():
            parts.extend(["", f"Context from earlier steps:\n{context}"])
        parts.extend(
            [
                "",
                "Return a concise plain-text result for this subtask. Do not return markdown.",
            ]
        )
        return "\n".join(parts)

    return OrchestratorOverrides(
        planner_instruction=(
            "You are planning a browser task. Break the objective into 1-4 concrete steps. "
            "Prefer verifying existing browser state before repeating work. "
            "Keep the plan short, action-oriented, and grounded in the current page."
        ),
        synthesizer_instruction=(
            "Synthesize the subtask results into the final compact JSON requested by the objective. "
            "Return JSON only. If the task is incomplete or blocked, set status to failed and explain why."
        ),
        get_task_prompt=get_task_prompt,
    )


def normalize_orchestrator_task_steps(plan_result: Any) -> list[dict[str, Any]]:
    step_results = getattr(plan_result, "step_results", None)
    if not isinstance(step_results, list):
        return []

    normalized_steps: list[dict[str, Any]] = []
    for step_index, step_result in enumerate(step_results):
        step = getattr(step_result, "step", None)
        title = str(getattr(step, "description", "") or "").strip()
        if not title:
            title = f"Step {step_index + 1}"

        task_summaries: list[dict[str, Any]] = []
        task_results = getattr(step_result, "task_results", None)
        if isinstance(task_results, list):
            for task_index, task_result in enumerate(task_results):
                task_title = str(getattr(task_result, "description", "") or "").strip()
                if not task_title:
                    task_title = f"Task {task_index + 1}"
                task_result_summary = str(
                    getattr(task_result, "result", "") or ""
                ).strip()
                task_summaries.append(
                    {
                        "title": task_title,
                        "status": "completed",
                        **(
                            {"resultSummary": task_result_summary}
                            if task_result_summary
                            else {}
                        ),
                    }
                )

        step_result_summary = str(getattr(step_result, "result", "") or "").strip()
        if not step_result_summary and task_summaries:
            step_result_summary = " | ".join(
                str(task.get("resultSummary") or "").strip()
                for task in task_summaries
                if str(task.get("resultSummary") or "").strip()
            )

        normalized_steps.append(
            {
                "title": title,
                "status": "completed",
                **(
                    {"resultSummary": step_result_summary}
                    if step_result_summary
                    else {}
                ),
                **({"tasks": task_summaries} if task_summaries else {}),
            }
        )

    return normalized_steps


def is_retryable_browser_workflow_error(message: str) -> bool:
    normalized = message.strip().lower()
    if not normalized:
        return True
    non_retryable_markers = (
        "missing api key",
        "providerconfig is required",
        "unsupported provider",
        "a linkedin profile url is required",
        "browser agent returned a response that was not valid json",
    )
    return not any(marker in normalized for marker in non_retryable_markers)


def build_retry_resume_context(
    *,
    existing_resume_context: str,
    attempt: int,
    error_message: str,
    page_state: dict[str, Any],
) -> str:
    parts: list[str] = []
    trimmed_existing = existing_resume_context.strip()
    if trimmed_existing:
        parts.append(trimmed_existing)

    parts.extend(
        [
            f"Retry attempt {attempt} after the browser task failed.",
            f"Last error: {error_message}",
        ]
    )

    page_url = str(page_state.get("pageUrl") or "").strip()
    if page_url:
        parts.append(f"Current page URL after failure: {page_url}")

    page_title = str(page_state.get("pageTitle") or "").strip()
    if page_title:
        parts.append(f"Current page title after failure: {page_title}")

    page_snapshot = str(page_state.get("pageSnapshot") or "").strip()
    if page_snapshot:
        parts.append(
            "Current page snapshot after failure:\n"
            + truncate_text(page_snapshot, 2500)
        )

    parts.append(
        "Do not restart from scratch if the page already reflects prior progress. Inspect the live page and continue from the furthest verified checkpoint."
    )
    return "\n\n".join(parts)


def build_resume_signal_context(
    *,
    existing_resume_context: str,
    resume_count: int,
    pause_reason: str,
    signal_payload: Any,
) -> str:
    parts: list[str] = []
    trimmed_existing = existing_resume_context.strip()
    if trimmed_existing:
        parts.append(trimmed_existing)

    parts.extend(
        [
            f"Workflow resume cycle {resume_count} after a paused browser task.",
            f"Reason the workflow paused: {pause_reason}",
        ]
    )

    if isinstance(signal_payload, dict):
        signal_resume_context = str(signal_payload.get("resumeContext") or "").strip()
        if signal_resume_context:
            parts.append(f"Resume instructions from the user:\n{signal_resume_context}")

        page_url = str(signal_payload.get("pageUrl") or "").strip()
        if page_url:
            parts.append(f"Current page URL at resume time: {page_url}")

        page_context = str(signal_payload.get("pageContext") or "").strip()
        if page_context:
            parts.append(
                "Observed page context at resume time:\n"
                + truncate_text(page_context, 2500)
            )

        user_context = str(signal_payload.get("userContext") or "").strip()
        if user_context:
            parts.append(
                "User-specific context supplied again at resume time:\n"
                + truncate_text(user_context, 2500)
            )

        structured = signal_payload.get("structured")
        if isinstance(structured, dict) and structured:
            parts.append(
                "Structured observation at resume time:\n"
                + truncate_text(json.dumps(structured, ensure_ascii=True), 2500)
            )

        scanned_candidates = signal_payload.get("scannedCandidates")
        if isinstance(scanned_candidates, list) and scanned_candidates:
            parts.append(
                "Candidate scan hints at resume time:\n"
                + truncate_text(
                    json.dumps(scanned_candidates[:8], ensure_ascii=True), 2000
                )
            )
    else:
        payload_text = str(signal_payload or "").strip()
        if payload_text:
            parts.append(f"Resume instructions from the user:\n{payload_text}")

    parts.append(
        "Resume from the furthest verified checkpoint. Re-check the live page before repeating any step that may already be complete."
    )
    return "\n\n".join(parts)


def merge_resume_signal_payload(
    *,
    current_payload: dict[str, Any],
    signal_payload: Any,
    pause_reason: str,
    resume_count: int,
) -> dict[str, Any]:
    merged_payload = dict(current_payload)
    normalized_signal_payload = (
        dict(signal_payload) if isinstance(signal_payload, dict) else None
    )

    if normalized_signal_payload is not None:
        for key in (
            "goal",
            "pageUrl",
            "platformHint",
            "pageContext",
            "siteExperienceContext",
            "userContext",
            "systemPrompt",
        ):
            value = normalized_signal_payload.get(key)
            if isinstance(value, str) and value.strip():
                merged_payload[key] = value.strip()

        field_target = normalized_signal_payload.get("fieldTarget")
        if isinstance(field_target, dict) and field_target:
            merged_payload["fieldTarget"] = dict(field_target)

        structured = normalized_signal_payload.get("structured")
        if isinstance(structured, dict) and structured:
            merged_payload["structured"] = dict(structured)

        scanned_candidates = normalized_signal_payload.get("scannedCandidates")
        if isinstance(scanned_candidates, list):
            merged_payload["scannedCandidates"] = list(scanned_candidates)

        resume_file = normalized_signal_payload.get("resumeFile")
        if isinstance(resume_file, dict) and resume_file:
            merged_payload["resumeFile"] = dict(resume_file)

    merged_payload["resumeContext"] = build_resume_signal_context(
        existing_resume_context=str(current_payload.get("resumeContext") or ""),
        resume_count=resume_count,
        pause_reason=pause_reason,
        signal_payload=signal_payload,
    )
    return merged_payload


class PythonBrowserRuntime:
    def __init__(self, agent: Agent | None, app: MCPApp | None = None):
        self.agent = agent
        self.app = app
        self._generic_task_workflow_cls: type[Workflow[dict[str, Any]]] | None = None
        self._generic_queue_workflow_cls: type[Workflow[dict[str, Any]]] | None = None
        self._linkedin_connect_batch_workflow_cls: (
            type[Workflow[dict[str, Any]]] | None
        ) = None

    def require_agent(self) -> Agent:
        if self.agent is None:
            raise RuntimeError("A live browser agent is not available in this runtime.")
        return self.agent

    @asynccontextmanager
    async def workflow_attempt_runtime(self):
        if self.agent is not None:
            yield self
            return
        if self.app is None:
            raise RuntimeError("Workflow browser execution requires an initialized app.")

        agent = Agent(
            name="chrome_runtime_workflow",
            server_names=["chrome-devtools"],
            context=self.app.context,
        )
        async with agent:
            yield PythonBrowserRuntime(agent, app=self.app)

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        trace: bool = True,
    ) -> Any:
        agent = self.require_agent()
        if trace:
            log_runtime(
                f"[mcp-tool] start name={name} args={summarize_json_value(args or {})}"
            )
        result = await agent.call_tool(
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
        agent = self.require_agent()
        provider = normalize_provider_name(str(provider_config.get("provider") or "openai"))
        api_key = str(provider_config.get("apiKey") or "").strip()
        model = str(provider_config.get("model") or "").strip()

        if not api_key:
            raise RuntimeError(
                "Missing API key for the configured provider. Add it in Settings before running browser tasks."
            )

        agent.instruction = instruction

        if provider == "openai":
            agent.context.config.openai = OpenAISettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(llm_factory=OpenAIAugmentedLLM)
        elif provider == "anthropic":
            agent.context.config.anthropic = AnthropicSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(llm_factory=AnthropicAugmentedLLM)
        else:
            agent.context.config.google = GoogleSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(llm_factory=GoogleAugmentedLLM)

        llm.instruction = instruction
        return llm, provider, model

    def create_generic_task_orchestrator(
        self,
        *,
        provider: str,
        model: str,
        system_prompt: str,
    ) -> Any:
        browser_operator_instruction = "\n\n".join(
            [
                "You are the browser operator worker for Chrome DevTools MCP tasks.",
                "Use Chrome DevTools MCP tools only.",
                "Inspect the page tree before interacting and verify the page after each major step.",
                "Do not stop at a plan when the objective explicitly asks for end-to-end browser action.",
                "Return concise factual results for each subtask.",
                f"Task-specific runtime instructions:\n{system_prompt}",
            ]
        )

        return create_orchestrator(
            available_agents=[
                AgentSpec(
                    name="browser_operator",
                    instruction=browser_operator_instruction,
                    server_names=["chrome-devtools"],
                )
            ],
            plan_type="iterative",
            provider=provider,
            model=model or None,
            overrides=build_generic_orchestrator_overrides(),
            name="browser_task_orchestrator",
            context=self.require_agent().context,
        )

    def create_generic_task_workflow_class(
        self,
    ) -> type[Workflow[dict[str, Any]]] | None:
        if self._generic_task_workflow_cls is not None:
            return self._generic_task_workflow_cls
        if self.app is None:
            return None

        runtime = self
        app = self.app

        @app.workflow
        class GenericBrowserTaskWorkflow(Workflow[dict[str, Any]]):
            @app.workflow_run
            async def run(
                self, payload: dict[str, Any]
            ) -> WorkflowResult[dict[str, Any]]:
                max_attempts = 3
                max_resume_cycles = 2
                attempt_history: list[dict[str, Any]] = []
                current_payload = dict(payload)
                resume_count = 0

                while True:
                    for attempt in range(1, max_attempts + 1):
                        self.update_status("running")
                        self.state.metadata["attempts"] = attempt
                        self.state.metadata["resumeCount"] = resume_count
                        self.state.metadata["recoveryHistory"] = attempt_history

                        try:
                            async with runtime.workflow_attempt_runtime() as active_runtime:
                                try:
                                    outcome = await active_runtime.execute_generic_browser_task_once(
                                        current_payload
                                    )
                                    metadata: dict[str, Any] = {
                                        "workflowName": "GenericBrowserTaskWorkflow",
                                        "executionEngine": str(
                                            runtime.app.context.config.execution_engine
                                        )
                                        if runtime.app is not None
                                        else "asyncio",
                                        "attempts": attempt,
                                        "resumeCount": resume_count,
                                        "recovered": attempt > 1 or resume_count > 0,
                                        "recoveryHistory": attempt_history,
                                    }
                                    outcome_metadata = outcome.get("metadata")
                                    if isinstance(outcome_metadata, dict):
                                        task_steps = outcome_metadata.get("taskSteps")
                                        if isinstance(task_steps, list) and task_steps:
                                            metadata["taskSteps"] = task_steps
                                        execution_mode = str(
                                            outcome_metadata.get("executionMode") or ""
                                        ).strip()
                                        if execution_mode:
                                            metadata["executionMode"] = execution_mode
                                        final_url = str(
                                            outcome_metadata.get("finalUrl") or ""
                                        ).strip()
                                        if final_url:
                                            metadata["finalUrl"] = final_url
                                            self.state.metadata["latestPageUrl"] = final_url

                                    self.state.metadata.pop("pauseReason", None)
                                    self.state.metadata.pop("awaitingSignal", None)
                                    self.state.metadata.pop("lastError", None)
                                    self.state.metadata.update(metadata)
                                    return WorkflowResult(value=outcome, metadata=metadata)
                                except Exception as error:
                                    message = normalize_error_message(
                                        error
                                        if isinstance(error, Exception)
                                        else Exception(str(error))
                                    )
                                    page_state = (
                                        await active_runtime.capture_selected_page_state()
                                    )
                                    history_item: dict[str, Any] = {
                                        "attempt": attempt,
                                        "resumeCount": resume_count,
                                        "error": message,
                                    }
                                    page_url = str(page_state.get("pageUrl") or "").strip()
                                    if page_url:
                                        history_item["pageUrl"] = page_url
                                        self.state.metadata["latestPageUrl"] = page_url
                                    attempt_history.append(history_item)
                                    self.state.metadata["lastError"] = message
                                    self.state.metadata["recoveryHistory"] = attempt_history

                                    if not is_retryable_browser_workflow_error(message):
                                        raise

                                    if attempt < max_attempts:
                                        current_payload = dict(current_payload)
                                        current_payload["resumeContext"] = (
                                            build_retry_resume_context(
                                                existing_resume_context=str(
                                                    current_payload.get("resumeContext")
                                                    or ""
                                                ),
                                                attempt=attempt,
                                                error_message=message,
                                                page_state=page_state,
                                            )
                                        )
                                        continue

                                    if resume_count >= max_resume_cycles:
                                        raise

                                    self.update_status("paused")
                                    self.state.metadata["pauseReason"] = message
                                    self.state.metadata["awaitingSignal"] = "resume"
                                    resume_payload = await app.context.executor.wait_for_signal(
                                        signal_name="resume",
                                        workflow_id=self.id,
                                        run_id=self.run_id,
                                        signal_description=(
                                            "Workflow paused after repeated browser-task failures. "
                                            "Resume to continue from the last checkpoint."
                                        ),
                                    )
                                    resume_count += 1
                                    current_payload = merge_resume_signal_payload(
                                        current_payload=current_payload,
                                        signal_payload=resume_payload,
                                        pause_reason=message,
                                        resume_count=resume_count,
                                    )
                                    self.update_status("running")
                                    self.state.metadata["resumeCount"] = resume_count
                                    self.state.metadata.pop("awaitingSignal", None)
                                    self.state.metadata.pop("pauseReason", None)
                                    break
                        except Exception:
                            raise

        self._generic_task_workflow_cls = GenericBrowserTaskWorkflow
        return self._generic_task_workflow_cls

    def create_generic_queue_workflow_class(
        self,
    ) -> type[Workflow[dict[str, Any]]] | None:
        if self._generic_queue_workflow_cls is not None:
            return self._generic_queue_workflow_cls
        if self.app is None:
            return None

        runtime = self
        app = self.app

        @app.workflow
        class GenericBrowserQueueWorkflow(Workflow[dict[str, Any]]):
            @app.workflow_run
            async def run(
                self, payload: dict[str, Any]
            ) -> WorkflowResult[dict[str, Any]]:
                items = coerce_generic_work_items(payload)
                if not items:
                    raise RuntimeError("workItems are required")

                completed = 0
                skipped = 0
                failed = 0
                task_steps: list[dict[str, Any]] = []

                for item in items:
                    page_url = str(item.get("pageUrl") or "").strip()
                    task_steps.append(
                        {
                            "title": str(item.get("title") or "Queued browser task").strip(),
                            "status": "pending",
                            **({"pageUrl": page_url} if page_url else {}),
                        }
                    )

                self.state.metadata.update(
                    {
                        "workflowName": "GenericBrowserQueueWorkflow",
                        "queueType": "generic_browser_queue",
                        "itemCount": len(items),
                        "completed": 0,
                        "skipped": 0,
                        "failed": 0,
                        "taskSteps": task_steps,
                    }
                )

                for index, item in enumerate(items):
                    self.update_status("running")
                    step = task_steps[index]
                    step["status"] = "running"
                    step["retryCount"] = 0
                    current_page_url = str(item.get("pageUrl") or "").strip()
                    if current_page_url:
                        self.state.metadata["latestPageUrl"] = current_page_url
                    self.state.metadata["taskSteps"] = task_steps

                    item_result: dict[str, Any] | None = None
                    item_error: str | None = None
                    max_attempts = 3

                    for attempt in range(1, max_attempts + 1):
                        step["retryCount"] = attempt - 1
                        step["status"] = "running" if attempt == 1 else "retrying"
                        self.state.metadata["taskSteps"] = task_steps
                        try:
                            item_payload = build_generic_queue_item_payload(payload, item)
                            async with runtime.workflow_attempt_runtime() as active_runtime:
                                item_result = await active_runtime.execute_generic_browser_task_once(
                                    item_payload
                                )
                            break
                        except Exception as error:
                            item_error = normalize_error_message(
                                error
                                if isinstance(error, Exception)
                                else Exception(str(error))
                            )
                            if attempt >= max_attempts:
                                break
                            await asyncio.sleep(human_delay(1600) / 1000)

                    if item_result is None:
                        failed += 1
                        step["status"] = "failed"
                        step["lastError"] = item_error or "Queued browser task failed."
                        self.state.metadata["failed"] = failed
                        self.state.metadata["taskSteps"] = task_steps
                        continue

                    metadata = (
                        dict(item_result.get("metadata"))
                        if isinstance(item_result.get("metadata"), dict)
                        else {}
                    )
                    outcome_status = (
                        str(metadata.get("status") or item_result.get("status") or "")
                        .strip()
                        .lower()
                    )
                    result_summary = str(item_result.get("summary") or "").strip()
                    final_url = str(metadata.get("finalUrl") or "").strip()
                    if final_url:
                        step["pageUrl"] = final_url
                        self.state.metadata["latestPageUrl"] = final_url

                    if outcome_status == "skipped":
                        skipped += 1
                        step["status"] = "skipped"
                        if result_summary:
                            step["skipReason"] = result_summary
                    else:
                        completed += 1
                        step["status"] = "completed"

                    if result_summary:
                        step["resultSummary"] = result_summary

                    self.state.metadata["completed"] = completed
                    self.state.metadata["skipped"] = skipped
                    self.state.metadata["failed"] = failed
                    self.state.metadata["taskSteps"] = task_steps
                    await asyncio.sleep(human_delay(1200) / 1000)

                summary_parts = [
                    f"Queued browser workflow finished for {len(items)} item{'s' if len(items) != 1 else ''}.",
                    f"Completed: {completed}.",
                ]
                if skipped > 0:
                    summary_parts.append(f"Skipped: {skipped}.")
                if failed > 0:
                    summary_parts.append(f"Failed: {failed}.")

                metadata = {
                    "kind": "execute_task_queue",
                    "workflowName": "GenericBrowserQueueWorkflow",
                    "queueType": "generic_browser_queue",
                    "itemCount": len(items),
                    "completed": completed,
                    "skipped": skipped,
                    "failed": failed,
                    "taskSteps": task_steps,
                }
                latest_page_url = str(self.state.metadata.get("latestPageUrl") or "").strip()
                if latest_page_url:
                    metadata["finalUrl"] = latest_page_url

                return WorkflowResult(
                    value={
                        "summary": " ".join(summary_parts),
                        "metadata": metadata,
                    },
                    metadata=metadata,
                )

        self._generic_queue_workflow_cls = GenericBrowserQueueWorkflow
        return self._generic_queue_workflow_cls

    def create_linkedin_connect_batch_workflow_class(
        self,
    ) -> type[Workflow[dict[str, Any]]] | None:
        if self._linkedin_connect_batch_workflow_cls is not None:
            return self._linkedin_connect_batch_workflow_cls
        if self.app is None:
            return None

        runtime = self
        app = self.app

        @app.workflow
        class LinkedInConnectBatchWorkflow(Workflow[dict[str, Any]]):
            @app.workflow_run
            async def run(
                self, payload: dict[str, Any]
            ) -> WorkflowResult[dict[str, Any]]:
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
                        round(
                            daily_limit
                            if isinstance(daily_limit, (int, float))
                            else len(raw_items)
                        ),
                    ),
                )
                items = [
                    item for item in raw_items[:max_items] if isinstance(item, dict)
                ]
                task_steps: list[dict[str, Any]] = []
                sent = 0
                skipped = 0
                failed = 0
                final_states: list[str] = []

                for item in items:
                    target_name = str(item.get("targetName") or "").strip() or str(
                        item.get("targetUrl") or ""
                    ).strip() or "LinkedIn profile"
                    target_url = str(item.get("targetUrl") or "").strip()
                    task_steps.append(
                        {
                            "title": f"Connect with {target_name}",
                            "status": "pending",
                            **({"pageUrl": target_url} if target_url else {}),
                        }
                    )

                self.state.metadata.update(
                    {
                        "workflowName": "LinkedInConnectBatchWorkflow",
                        "batchType": "linkedin_connect",
                        "itemCount": len(items),
                        "sent": 0,
                        "skipped": 0,
                        "failed": 0,
                        "taskSteps": task_steps,
                    }
                )

                for index, item in enumerate(items):
                    self.update_status("running")
                    step = task_steps[index]
                    step["status"] = "running"
                    step["retryCount"] = 0
                    self.state.metadata["taskSteps"] = task_steps
                    target_url = str(item.get("targetUrl") or "").strip()
                    if target_url:
                        self.state.metadata["latestPageUrl"] = target_url

                    item_result: dict[str, Any] | None = None
                    item_error: str | None = None
                    max_attempts = 2

                    for attempt in range(1, max_attempts + 1):
                        step["retryCount"] = attempt - 1
                        self.state.metadata["taskSteps"] = task_steps
                        try:
                            async with runtime.workflow_attempt_runtime() as active_runtime:
                                item_result = await active_runtime.execute_linkedin_connect_item(
                                    item, provider_config
                                )
                            break
                        except Exception as error:
                            item_error = normalize_error_message(
                                error
                                if isinstance(error, Exception)
                                else Exception(str(error))
                            )
                            if attempt >= max_attempts:
                                break
                            await asyncio.sleep(human_delay(1800) / 1000)

                    if item_result is None:
                        failed += 1
                        step["status"] = "failed"
                        step["lastError"] = item_error or "LinkedIn connect item failed."
                        final_states.append("failed")
                        self.state.metadata["failed"] = failed
                        self.state.metadata["taskSteps"] = task_steps
                        continue

                    final_state = str(item_result.get("finalState") or "").strip() or "failed"
                    final_states.append(final_state)
                    item_summary = str(item_result.get("summary") or "").strip()
                    preserve_page = bool(item_result.get("preservePage"))
                    if preserve_page and target_url:
                        self.state.metadata["latestPageUrl"] = target_url

                    outcome = str(item_result.get("outcome") or "").strip()
                    if outcome == "sent":
                        sent += 1
                        step["status"] = "completed"
                    elif outcome == "skipped":
                        skipped += 1
                        step["status"] = "skipped"
                        step["skipReason"] = item_summary or final_state
                    else:
                        failed += 1
                        step["status"] = "failed"
                        step["lastError"] = item_summary or final_state

                    if item_summary:
                        step["resultSummary"] = item_summary

                    self.state.metadata["sent"] = sent
                    self.state.metadata["skipped"] = skipped
                    self.state.metadata["failed"] = failed
                    self.state.metadata["taskSteps"] = task_steps

                    await asyncio.sleep(human_delay(2200) / 1000)

                summary_parts = [
                    f"LinkedIn connect batch finished for {len(items)} target{'s' if len(items) != 1 else ''}.",
                    f"Sent: {sent}.",
                ]
                if skipped > 0:
                    summary_parts.append(f"Skipped: {skipped}.")
                if failed > 0:
                    summary_parts.append(f"Failed: {failed}.")

                metadata = {
                    "workflowName": "LinkedInConnectBatchWorkflow",
                    "batchType": "linkedin_connect",
                    "itemCount": len(items),
                    "sent": sent,
                    "skipped": skipped,
                    "failed": failed,
                    "finalStates": final_states,
                    "taskSteps": task_steps,
                }
                latest_page_url = str(self.state.metadata.get("latestPageUrl") or "").strip()
                if latest_page_url:
                    metadata["finalUrl"] = latest_page_url

                return WorkflowResult(
                    value={
                        "summary": " ".join(summary_parts),
                        "metadata": {
                            "kind": "execute_task_batch",
                            **metadata,
                        },
                    },
                    metadata=metadata,
                )

        self._linkedin_connect_batch_workflow_cls = LinkedInConnectBatchWorkflow
        return self._linkedin_connect_batch_workflow_cls

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
        response_text = ""
        execution_mode = "direct_llm"
        plan_steps: list[dict[str, Any]] = []
        request_params = RequestParams(
            model=model or None,
            max_iterations=max_iterations,
            maxTokens=max_tokens,
            temperature=0.1,
            use_history=False,
            reasoning_effort="medium" if provider == "openai" else None,
        )

        if task_label == "generic_browser_task":
            runner: Any | None = None
            try:
                runner = self.create_generic_task_orchestrator(
                    provider=provider,
                    model=model,
                    system_prompt=system_prompt,
                )
                execution_mode = "iterative_orchestrator"
                log_runtime(
                    f"[agent-task] using_iterative_orchestrator label={task_label}"
                )
            except Exception as error:
                log_runtime(
                    f"[agent-task] orchestrator_fallback label={task_label} reason={normalize_error_message(error if isinstance(error, Exception) else Exception(str(error)))}"
                )
                execution_mode = "direct_llm"
            if runner is not None:
                plan_result = await runner.execute(
                    user_prompt,
                    request_params,
                )
                response_text = str(getattr(plan_result, "result", "") or "")
                plan_steps = normalize_orchestrator_task_steps(plan_result)
                log_runtime(
                    f"[agent-task] orchestrator_steps label={task_label} count={len(plan_steps)}"
                )
            else:
                response_text = await llm.generate_str(
                    user_prompt,
                    request_params,
                )
        else:
            response_text = await llm.generate_str(
                user_prompt,
                request_params,
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
        if plan_steps:
            parsed["_planSteps"] = plan_steps
        parsed["_executionMode"] = execution_mode
        parsed["_rawResponse"] = response_text
        return parsed

    async def health(self) -> dict[str, Any]:
        pages = await self.list_pages(trace=False)
        return {
            "connected": True,
            "pageCount": len(pages),
        }

    async def derive_browser_work_items(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        provider_config = payload.get("providerConfig")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

        page_url = str(payload.get("pageUrl") or "").strip()
        if page_url:
            focused_page = await self.focus_or_open_page(page_url)
            await self.wait_for_page_ready(focused_page["pageId"], 15000)

        llm, provider, model = await self.attach_augmented_llm(
            provider_config,
            build_effective_system_prompt(
                BASE_AGENT_SYSTEM_PROMPT,
                str(payload.get("systemPrompt") or "").strip() or None,
            ),
        )
        response_text = await llm.generate_str(
            build_work_item_discovery_prompt(payload),
            RequestParams(
                model=model or None,
                max_iterations=8,
                maxTokens=1400,
                temperature=0.1,
                use_history=False,
                reasoning_effort="medium" if provider == "openai" else None,
            ),
        )
        parsed = extract_json_payload(response_text)
        summary = (
            str(parsed.get("summary") or "").strip()
            or "Analyzed the live page for repeated actionable items."
        )
        mode = str(parsed.get("mode") or "").strip().lower()
        work_items = normalize_work_items(parsed.get("workItems"))
        if len(work_items) <= 1:
            return {
                "mode": "single",
                "summary": summary,
                "workItems": work_items,
            }
        if mode != "queue":
            mode = "queue"
        return {
            "mode": mode,
            "summary": summary,
            "workItems": work_items,
        }

    async def execute_generic_browser_task_once(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        provider_config = payload.get("providerConfig")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

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
            "executionMode": str(agent_result.get("_executionMode") or "").strip()
            or "direct_llm",
        }
        if focused_page:
            metadata["pageId"] = focused_page["pageId"]
        final_url = str(agent_result.get("finalUrl") or "").strip()
        if final_url:
            metadata["finalUrl"] = final_url
        plan_steps = agent_result.get("_planSteps")
        if isinstance(plan_steps, list) and plan_steps:
            metadata["taskSteps"] = plan_steps

        return {
            "summary": summary,
            "metadata": metadata,
        }

    async def start_generic_browser_task_workflow(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        workflow_cls = self.create_generic_task_workflow_class()
        if workflow_cls is None:
            raise RuntimeError("Generic browser task workflow is not available.")

        if self.app is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        workflow = workflow_cls(context=self.app.context)
        execution = await workflow.run_async(
            dict(payload),
            __mcp_agent_workflow_id=f"generic_browser_task_{uuid.uuid4().hex}",
        )
        return {
            "workflowId": execution.workflow_id,
            "runId": execution.run_id,
        }

    async def start_generic_browser_queue_workflow(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        workflow_cls = self.create_generic_queue_workflow_class()
        if workflow_cls is None:
            raise RuntimeError("Generic browser queue workflow is not available.")

        if self.app is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        workflow = workflow_cls(context=self.app.context)
        execution = await workflow.run_async(
            dict(payload),
            __mcp_agent_workflow_id=f"generic_browser_queue_{uuid.uuid4().hex}",
        )
        return {
            "workflowId": execution.workflow_id,
            "runId": execution.run_id,
        }

    async def start_linkedin_connect_batch_workflow(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        workflow_cls = self.create_linkedin_connect_batch_workflow_class()
        if workflow_cls is None:
            raise RuntimeError("LinkedIn connect batch workflow is not available.")

        if self.app is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        workflow = workflow_cls(context=self.app.context)
        execution = await workflow.run_async(
            dict(payload),
            __mcp_agent_workflow_id=f"linkedin_connect_batch_{uuid.uuid4().hex}",
        )
        return {
            "workflowId": execution.workflow_id,
            "runId": execution.run_id,
        }

    async def get_workflow_status(
        self, *, workflow_id: str | None = None, run_id: str | None = None
    ) -> dict[str, Any] | None:
        registry = getattr(self.app.context if self.app is not None else None, "workflow_registry", None)
        if registry is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        return await registry.get_workflow_status(
            run_id=run_id,
            workflow_id=workflow_id,
        )

    async def resume_workflow(
        self,
        *,
        workflow_id: str | None = None,
        run_id: str | None = None,
        signal_name: str | None = "resume",
        payload: Any | None = None,
    ) -> bool:
        registry = getattr(self.app.context if self.app is not None else None, "workflow_registry", None)
        if registry is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        return bool(
            await registry.resume_workflow(
                run_id=run_id,
                workflow_id=workflow_id,
                signal_name=signal_name,
                payload=payload,
            )
        )

    async def cancel_workflow(
        self, *, workflow_id: str | None = None, run_id: str | None = None
    ) -> bool:
        registry = getattr(self.app.context if self.app is not None else None, "workflow_registry", None)
        if registry is None:
            raise RuntimeError("Workflow registry is not available in the runtime context.")
        return bool(
            await registry.cancel_workflow(
                run_id=run_id,
                workflow_id=workflow_id,
            )
        )

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
                    "resumeContext": str(payload.get("resumeContext") or "").strip(),
                    "siteExperienceContext": str(payload.get("siteExperienceContext") or "").strip(),
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

        workflow_cls = self.create_generic_task_workflow_class()
        if workflow_cls is None:
            return await self.execute_generic_browser_task_once(payload)

        workflow = workflow_cls(context=self.agent.context)
        workflow_result = await workflow.run(dict(payload))
        outcome = workflow_result.value
        if not isinstance(outcome, dict):
            raise RuntimeError(
                "Generic browser task workflow returned an invalid result."
            )

        metadata = outcome.get("metadata")
        if isinstance(metadata, dict):
            workflow_metadata = dict(workflow_result.metadata or {})
            if workflow_metadata:
                metadata["workflow"] = workflow_metadata
        return outcome


async def create_temporal_worker(app: MCPApp) -> Worker:
    if not isinstance(app.executor, TemporalExecutor):
        raise RuntimeError("Temporal worker startup requires a TemporalExecutor.")

    await app.executor.ensure_client()
    temporal_executor._preload_workflow_task_modules(app)

    agent_tasks = AgentTasks(context=app.context)
    app.workflow_task()(agent_tasks.call_tool_task)
    app.workflow_task()(agent_tasks.get_capabilities_task)
    app.workflow_task()(agent_tasks.get_prompt_task)
    app.workflow_task()(agent_tasks.initialize_aggregator_task)
    app.workflow_task()(agent_tasks.list_prompts_task)
    app.workflow_task()(agent_tasks.list_tools_task)
    app.workflow_task()(agent_tasks.shutdown_aggregator_task)

    system_activities = SystemActivities(context=app.context)
    app.workflow_task(name="mcp_forward_log")(system_activities.forward_log)
    app.workflow_task(name="mcp_request_user_input")(system_activities.request_user_input)
    app.workflow_task(name="mcp_relay_notify")(system_activities.relay_notify)
    app.workflow_task(name="mcp_relay_request")(system_activities.relay_request)

    app._register_global_workflow_tasks()

    task_registry = app.context.task_registry
    activities = [
        task_registry.get_activity(name) for name in task_registry.list_activities()
    ]
    workflows = app.context.app.workflows.values()

    return Worker(
        client=app.executor.client,
        task_queue=app.executor.config.task_queue,
        activities=activities,
        workflows=workflows,
        interceptors=[ContextPropagationInterceptor()],
    )


async def run_runtime() -> None:
    workflow_settings = build_settings()
    direct_app = MCPApp(
        name="cheatresume_python_browser_runtime",
        settings=build_runtime_settings("asyncio"),
    )

    async with direct_app.run():
        agent = Agent(
            name="chrome_runtime",
            server_names=["chrome-devtools"],
            context=direct_app.context,
        )

        async with agent:
            runtime = PythonBrowserRuntime(agent, app=direct_app)
            temporal_worker: Worker | None = None
            temporal_worker_task: asyncio.Task[None] | None = None
            temporal_app: MCPApp | None = None
            temporal_app_run_context = None
            workflow_runtime: PythonBrowserRuntime | None = None
            try:
                if workflow_settings.execution_engine == "temporal":
                    temporal_app = MCPApp(
                        name="cheatresume_python_browser_workflows",
                        settings=workflow_settings,
                    )
                    temporal_app_run_context = temporal_app.run()
                    await temporal_app_run_context.__aenter__()
                    workflow_runtime = PythonBrowserRuntime(None, app=temporal_app)
                    workflow_runtime.create_generic_task_workflow_class()
                    workflow_runtime.create_generic_queue_workflow_class()
                    workflow_runtime.create_linkedin_connect_batch_workflow_class()
                    temporal_worker = await create_temporal_worker(temporal_app)
                    temporal_worker_task = asyncio.create_task(temporal_worker.run())
                    log_runtime(
                        f"[temporal-worker] started host={build_temporal_host()} task_queue={temporal_app.executor.config.task_queue}"
                    )
                while True:
                    request_id = "unknown"
                    try:
                        if temporal_worker_task is not None and temporal_worker_task.done():
                            temporal_worker_task.result()

                        while True:
                            raw_line = await read_request_line()
                            if raw_line == "":
                                return

                            line = raw_line.strip()
                            if line:
                                break

                        request = json.loads(line)
                        request_id = str(request.get("id", "unknown"))
                        method = request.get("method")
                        args = request.get("args")
                        if not isinstance(args, dict):
                            args = {}

                        if method == "shutdown":
                            write_response(
                                {"id": request_id, "ok": True, "result": {"ok": True}}
                            )
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

                        if method == "derive_browser_work_items":
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await runtime.derive_browser_work_items(args)
                                    ),
                                }
                            )
                            continue

                        if method == "start_generic_browser_task_workflow":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.start_generic_browser_task_workflow(
                                            args
                                        )
                                    ),
                                }
                            )
                            continue

                        if method == "start_generic_browser_queue_workflow":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.start_generic_browser_queue_workflow(
                                            args
                                        )
                                    ),
                                }
                            )
                            continue

                        if method == "start_linkedin_connect_batch_workflow":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.start_linkedin_connect_batch_workflow(
                                            args
                                        )
                                    ),
                                }
                            )
                            continue

                        if method == "get_workflow_status":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.get_workflow_status(
                                            workflow_id=(
                                                str(args.get("workflowId") or "").strip()
                                                or None
                                            ),
                                            run_id=(
                                                str(args.get("runId") or "").strip()
                                                or None
                                            ),
                                        )
                                    ),
                                }
                            )
                            continue

                        if method == "resume_workflow":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.resume_workflow(
                                            workflow_id=(
                                                str(args.get("workflowId") or "").strip()
                                                or None
                                            ),
                                            run_id=(
                                                str(args.get("runId") or "").strip()
                                                or None
                                            ),
                                            signal_name=(
                                                str(args.get("signalName") or "").strip()
                                                or "resume"
                                            ),
                                            payload=args.get("payload"),
                                        )
                                    ),
                                }
                            )
                            continue

                        if method == "cancel_workflow":
                            workflow_handler = workflow_runtime or runtime
                            write_response(
                                {
                                    "id": request_id,
                                    "ok": True,
                                    "result": serialize_result(
                                        await workflow_handler.cancel_workflow(
                                            workflow_id=(
                                                str(args.get("workflowId") or "").strip()
                                                or None
                                            ),
                                            run_id=(
                                                str(args.get("runId") or "").strip()
                                                or None
                                            ),
                                        )
                                    ),
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
            finally:
                if temporal_worker is not None:
                    await temporal_worker.shutdown()
                if temporal_worker_task is not None:
                    with suppress(asyncio.CancelledError):
                        await temporal_worker_task
                if temporal_app_run_context is not None:
                    await temporal_app_run_context.__aexit__(None, None, None)


def main() -> None:
    try:
        asyncio.run(run_runtime())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
