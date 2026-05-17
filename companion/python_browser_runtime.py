#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import random
import re
import sys
import tempfile
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
You are a browser control agent operating through Chrome DevTools MCP tools.
Always call take_snapshot before clicking, typing, or filling — it shows the live DOM tree.
Use take_screenshot when you need to visually verify the page (buttons, forms, modals, visual content).
Prefer built-in browser tools: list_pages, select_page, new_page, navigate_page,
take_snapshot, take_screenshot, click, fill, fill_form, type_text, press_key, wait_for, close_page.
Use evaluate_script only when a built-in tool cannot complete verification or the page
requires a capability the built-in tools do not provide.
When the user's goal explicitly asks you to fill, submit, search, navigate, click, send,
connect, or otherwise complete an on-page task, perform that task instead of stopping at a plan.
Avoid destructive billing, account-security, or data-deletion actions unless the user explicitly asked for them.
Never claim success unless you verified it from the live browser state (snapshot or screenshot).
Return only compact JSON that matches the requested schema. Do not return markdown.
CONTENT GENERATION: You CAN and SHOULD generate text content yourself (essays, cover letters,
emails, summaries, code, etc.) when the task requires writing something. If the goal asks you to
write an essay or any document content, compose the text yourself and type it into the page using
type_text. Do NOT refuse content generation tasks. Do NOT try to use AI-assist buttons inside apps
(like "Write with Gemini" in Google Docs) — generate and type the content directly yourself.
EXTENSION UI: The page snapshot may contain a browser extension overlay with attribute data-tfa-ui.
This is NOT part of the website — it is the control panel for this agent itself.
NEVER interact with any element that has data-tfa-ui, aria-label containing "Agent", or that
appears to be a floating panel at the bottom center of the screen. Always interact with the
actual website content instead.
""".strip()

PLANNER_SYSTEM_PROMPT = """
You are a planning agent. Your ONLY job is to produce a JSON task plan.
Do NOT call any tools. Do NOT navigate, click, or take snapshots.
The live page snapshot is already embedded in the user prompt — read it there.
Return ONLY valid JSON. No markdown, no explanation, no code blocks.
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


def build_runtime_settings() -> Settings:
    cwd = os.getenv("MCP_AGENT_BRIDGE_CWD", "").strip() or os.getcwd()
    command = os.getenv("CHROME_DEVTOOLS_MCP_COMMAND", "").strip() or "npx"
    allowed_env = {
        key: value for key, value in os.environ.items() if isinstance(value, str)
    }

    settings = Settings(
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


_SITE_URL_MAP: dict[str, str] = {
    "amazon": "https://www.amazon.com",
    "google": "https://www.google.com",
    "linkedin": "https://www.linkedin.com",
    "github": "https://www.github.com",
    "twitter": "https://www.twitter.com",
    "x.com": "https://www.x.com",
    "facebook": "https://www.facebook.com",
    "instagram": "https://www.instagram.com",
    "reddit": "https://www.reddit.com",
    "youtube": "https://www.youtube.com",
    "gmail": "https://mail.google.com",
    "outlook": "https://outlook.live.com",
    "slack": "https://slack.com",
    "notion": "https://www.notion.so",
    "shopify": "https://www.shopify.com",
    "ebay": "https://www.ebay.com",
    "etsy": "https://www.etsy.com",
    "wikipedia": "https://www.wikipedia.org",
    "scholar": "https://scholar.google.com",
    "google scholar": "https://scholar.google.com",
}

_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\b([\w-]+\.(?:com|org|net|io|co|gov|edu|app|dev))\b", re.IGNORECASE)
_LINKEDIN_PROFILE_RE = re.compile(
    r"https://(?:www\.)?linkedin\.com/in/([a-zA-Z0-9_%-]+)/?", re.IGNORECASE
)


def _extract_linkedin_profile_urls(text: str) -> list[str]:
    """Return deduplicated LinkedIn profile URLs found in text, preserving order."""
    seen: set[str] = set()
    result: list[str] = []
    for m in _LINKEDIN_PROFILE_RE.finditer(text):
        url = m.group(0).rstrip("/") + "/"
        if url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _infer_name_from_linkedin_url(url: str) -> str:
    """Convert 'https://www.linkedin.com/in/john-doe/' → 'John Doe'."""
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    return " ".join(part.capitalize() for part in slug.replace("-", " ").split())


def _build_connect_step(profile_url: str, goal: str, count_label: str = "") -> dict[str, Any]:
    name = _infer_name_from_linkedin_url(profile_url)
    title_suffix = f" {count_label}" if count_label else ""
    return {
        "title": f"Send Connection to {name}{title_suffix}",
        "description": (
            f"Navigate to {profile_url} and send a LinkedIn connection request "
            f"with a personalized note based on the goal: {goal}"
        ),
        "critical": False,
        "_injected": True,
    }


def _extract_step_target_url(step: dict[str, Any], current_url: str) -> str | None:
    """
    If a step clearly intends to navigate to a specific site and the browser is
    NOT already there, return the target URL so _execute_step can pre-navigate.
    Returns None when no pre-navigation is needed.
    """
    from urllib.parse import urlparse
    title = str(step.get("title") or "").strip().lower()
    description = str(step.get("description") or "").strip()
    desc_lower = description.lower()

    # Guard: if a step targets LinkedIn people search but the browser is on
    # linkedin.com/jobs, pre-navigate to the people search URL so the executor
    # does not waste iterations searching within Jobs postings.
    if "linkedin.com/jobs" in current_url and (
        "people" in title or "people" in desc_lower
        or "recruiter" in title or "recruiter" in desc_lower
        or "search/results/people" in description
    ):
        url_match = _URL_RE.search(description)
        if url_match and "linkedin.com/search" in url_match.group(0):
            return url_match.group(0).rstrip(".,)")
        # Fall back to base people search; executor will fill keywords.
        return "https://www.linkedin.com/search/results/people/"

    # Only activate for navigation-intent steps.
    nav_keywords = ("navigate to", "go to", "open ", "visit ")
    if not any(title.startswith(kw) or title.startswith("navigate") for kw in nav_keywords):
        if "navigate to" not in title and not title.startswith("go to") and not title.startswith("open "):
            return None

    # 1. Explicit URL in description takes highest priority.
    url_match = _URL_RE.search(description)
    if url_match:
        target = url_match.group(0).rstrip(".,)")
        try:
            parsed_target = urlparse(target)
            parsed_current = urlparse(current_url)
            # Same-domain navigation (e.g. jobs → people search) is also valid.
            if parsed_target.netloc and (
                parsed_target.netloc != parsed_current.netloc
                or parsed_target.path != parsed_current.path
            ):
                return target
        except Exception:
            pass

    # 2. Well-known site name in step title.
    for site_name, site_url in _SITE_URL_MAP.items():
        if site_name in title:
            try:
                if urlparse(current_url).netloc not in site_url:
                    return site_url
            except Exception:
                pass
            break

    # 3. Domain pattern in description (e.g. "navigate to shopify.com").
    domain_match = _DOMAIN_RE.search(description)
    if domain_match:
        domain = domain_match.group(1)
        try:
            if domain not in urlparse(current_url).netloc:
                return f"https://www.{domain}"
        except Exception:
            pass

    return None


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
        return "google"
    if normalized not in {"openai", "anthropic", "google"}:
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


def is_linkedin_profile_connect_goal(payload: dict[str, Any]) -> bool:
    goal = str(payload.get("goal") or "").strip().lower()
    platform_hint = str(payload.get("platformHint") or "").strip().lower()
    page_url = str(payload.get("pageUrl") or "").strip().lower()
    if not goal:
        return False
    is_linkedin = platform_hint == "linkedin" or "linkedin.com" in page_url
    is_profile = "linkedin.com/in/" in page_url
    wants_connect = any(
        phrase in goal
        for phrase in ("connect", "connection request", "invite", "add a note", "connection note")
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
            "CRITICAL — typing the note:",
            "- After clicking 'Add a note', LinkedIn opens a MODAL DIALOG (role=dialog) in the CENTER of the page.",
            "- That modal contains the textarea where you must type the note.",
            "- The textarea you must type into will be INSIDE the dialog/modal — NOT at the bottom of the page.",
            "- NEVER type into any textarea at the bottom center of the page.",
            "- NEVER interact with any element that has a data-tfa-ui attribute (those are part of the browser extension UI, not LinkedIn).",
            "- Before filling any textarea, confirm its UID is inside a dialog element by checking the snapshot tree.",
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


class PythonBrowserRuntime:
    def __init__(self, agent: Agent | None, app: MCPApp | None = None):
        self.agent = agent
        self.app = app
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def require_agent(self) -> Agent:
        if self.agent is None:
            raise RuntimeError("A live browser agent is not available in this runtime.")
        return self.agent

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

        # Always pass context=agent.context explicitly so the LLM uses the asyncio
        # executor from direct_app.  Without this, the LLM falls back to
        # get_current_context() which may resolve to the temporal_app context
        # (TemporalExecutor) when running inside a Temporal activity, causing
        # "TemporalExecutor.execute must be called from within a workflow".
        agent_ctx = agent.context
        if provider == "openai":
            agent_ctx.config.openai = OpenAISettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(
                llm=OpenAIAugmentedLLM(agent=agent, context=agent_ctx)
            )
        elif provider == "anthropic":
            agent_ctx.config.anthropic = AnthropicSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(
                llm=AnthropicAugmentedLLM(agent=agent, context=agent_ctx)
            )
        else:
            agent_ctx.config.google = GoogleSettings(
                api_key=api_key,
                default_model=model or None,
            )
            llm = await agent.attach_llm(
                llm=GoogleAugmentedLLM(agent=agent, context=agent_ctx)
            )

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

        # Always use direct LLM for browser tasks.  The orchestrator pattern
        # opened a fresh chrome-devtools MCP connection per sub-agent and made
        # two LLM calls per step (planner + worker), making single clicks take
        # 2-3 minutes.  The persistent agent already has chrome-devtools tools
        # loaded; llm.generate_str() reuses that connection and needs only one
        # LLM call per tool cycle — same throughput, 2-3x lower latency.
        #
        # Retry loop: mcp-agent returns empty string on 429 rate-limit instead
        # of raising.  We wait inside the activity (keeping the heartbeat alive)
        # rather than failing and letting Temporal restart from scratch, which
        # would race multiple activities back to the API at the same time.
        _rate_limit_wait = 75  # seconds — slightly over the 56 s max the API reports
        _max_llm_attempts = 4
        for _llm_attempt in range(1, _max_llm_attempts + 1):
            response_text = await llm.generate_str(
                user_prompt,
                request_params,
            )
            if response_text.strip():
                break
            if _llm_attempt < _max_llm_attempts:
                log_runtime(
                    f"[agent-task] rate_limited label={task_label} "
                    f"attempt={_llm_attempt}/{_max_llm_attempts} "
                    f"waiting={_rate_limit_wait}s"
                )
                await asyncio.sleep(_rate_limit_wait)
        log_runtime(
            f"[agent-task] complete label={task_label} response={truncate_text(response_text, 400)}"
        )
        if not response_text.strip():
            raise RuntimeError(
                f"LLM returned empty response for task {task_label!r} after "
                f"{_max_llm_attempts} attempts (rate-limited); Temporal will retry"
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

    def _emit_progress(self, event: dict[str, Any]) -> None:
        print(json.dumps({"__progress__": True, **event}), flush=True)

    async def _take_planning_snapshot(self) -> str:
        """Take a live DOM snapshot to ground the plan in reality."""
        try:
            result = await self.call_tool("take_snapshot", trace=False)
            text = tool_result_text(result).strip()
            return text[:4000] if text else ""
        except Exception:
            return ""

    async def _get_actual_selected_url(self) -> str:
        """Query Chrome for the URL of the currently selected page (ground truth)."""
        try:
            pages = await self.list_pages(trace=False)
            selected = next((p for p in pages if p.get("selected")), pages[0] if pages else None)
            return str(selected.get("url") or "").strip() if selected else ""
        except Exception:
            return ""

    def _build_plan_prompt(
        self, payload: dict[str, Any], live_snapshot: str = ""
    ) -> str:
        goal = str(payload.get("goal") or "").strip()
        page_url = str(payload.get("pageUrl") or "").strip()
        platform_hint = str(payload.get("platformHint") or "").strip()
        page_context = str(payload.get("pageContext") or "").strip()
        user_context = str(payload.get("userContext") or "").strip()
        resume_context = str(payload.get("resumeContext") or "").strip()
        site_experience_context = str(payload.get("siteExperienceContext") or "").strip()
        work_items = payload.get("workItems")
        field_target = payload.get("fieldTarget")
        structured = payload.get("structured")
        scanned_candidates = payload.get("scannedCandidates")
        resume_file = payload.get("resumeFile")

        # Build ordered context sections — most important first
        sections: list[str] = []

        # Live snapshot is the ground truth; stale pageContext is last resort
        if live_snapshot:
            sections.append(f"=== LIVE PAGE STATE ===\n{live_snapshot[:3500]}")
        elif page_context:
            sections.append(f"=== PAGE CONTEXT (stale — no live snapshot available) ===\n{page_context[:400]}")

        # User identity / profile — always first so it's never truncated
        if user_context:
            sections.append(f"=== USER CONTEXT ===\n{user_context[:800]}")

        # Target field (form-filling tasks)
        if isinstance(field_target, dict):
            ft_lines = ["=== TARGET FIELD ==="]
            ftype = str(field_target.get("fieldType") or "").strip()
            selector = str(field_target.get("selector") or "").strip()
            char_limit = field_target.get("charLimit")
            if ftype:
                ft_lines.append(f"Field type: {ftype}")
            if selector:
                ft_lines.append(f"CSS selector: {selector}")
            if char_limit:
                ft_lines.append(f"Character limit: {char_limit}")
            sections.append("\n".join(ft_lines))

        # Pre-extracted structured form data (huge signal for job applications)
        if isinstance(structured, dict) and structured:
            sections.append(
                f"=== PRE-EXTRACTED FORM DATA ===\n"
                f"{json.dumps(structured, ensure_ascii=True)[:1200]}"
            )

        # Scan targets (LinkedIn profile lists, etc.)
        if isinstance(scanned_candidates, list) and scanned_candidates:
            sections.append(
                f"=== SCAN TARGETS ===\n"
                f"{json.dumps(scanned_candidates[:8], ensure_ascii=True)[:1200]}"
            )

        # Work item batch
        if isinstance(work_items, list) and work_items:
            item_lines: list[str] = []
            for item in work_items[:10]:
                if isinstance(item, dict):
                    title = str(item.get("title") or item.get("targetName") or "").strip()
                    url = str(item.get("targetUrl") or item.get("pageUrl") or "").strip()
                    goal_hint = str(item.get("itemGoal") or "").strip()
                    if title or url:
                        entry = f"- {title}"
                        if url:
                            entry += f" ({url})"
                        if goal_hint:
                            entry += f" → {goal_hint}"
                        item_lines.append(entry)
            if item_lines:
                sections.append(
                    f"=== WORK ITEMS ({len(work_items)} total) ===\n" + "\n".join(item_lines)
                )

        # Resume file hint (job application tasks)
        if isinstance(resume_file, dict) and resume_file.get("base64"):
            resume_name = str(resume_file.get("name") or "resume.pdf").strip()
            sections.append(
                f"=== RESUME FILE ===\n"
                f"User's resume ({resume_name}) is available. "
                f"Include a dedicated upload step if the task involves a file input."
            )

        # Previous run context (resumed tasks)
        if resume_context:
            sections.append(f"=== PREVIOUS RUN CONTEXT ===\n{resume_context[:600]}")

        # Learned patterns for this site
        if site_experience_context:
            sections.append(f"=== SITE EXPERIENCE (what has worked here before) ===\n{site_experience_context[:600]}")

        context_block = "\n\n".join(sections)
        page_header = page_url or "(unknown)"
        if platform_hint:
            page_header += f"  [platform: {platform_hint}]"

        return f"""You are a planning agent. Produce a concrete, executable step-by-step plan.
You are NOT executing — a separate executor runs each step with up to 15 tool calls.

=== GOAL ===
{goal}
Current page: {page_header}

{context_block}

=== PLANNING RULES ===
1. GROUNDED — Every step must reference exact element names, button labels, or URLs visible in the live snapshot. Never invent or guess UI elements.
2. BOUNDED — Each step should be completable in ~15 LLM tool calls: one focused action + verification. Don't bundle unrelated actions.
3. SPECIFIC — Step descriptions must include success criteria: what the executor should see after acting ("confirm cart shows 1 item", "verify URL changed to /checkout").
4. CRITICAL — Mark critical:true if failure should abort the whole task. Mark critical:false for optional verifications or nice-to-have steps.
5. CROSS-DOMAIN — If the task requires navigating to a different site or domain, make "Navigate to <URL>" an explicit step.
6. OBSTACLES FIRST — If the snapshot shows a cookie banner, GDPR dialog, modal overlay, or login wall, the first step must handle it before any other action.
7. FORM GROUPING — Group related form fields into one step. Do NOT create one step per field (e.g., "Fill personal details" covers name + email + phone).
8. BATCH ITEMS — For work item lists, create one step per item (up to 8 max). Remaining items continue via progress.
9. RESUME AWARENESS — If PREVIOUS RUN CONTEXT is present, check what was already completed and skip those steps.
10. STEP COUNT — Simple task: 1–3 steps. Multi-page task: 4–6 steps. Complex batch: up to 8 steps. Never exceed 8.
11. LINKEDIN PEOPLE vs JOBS — CRITICAL: LinkedIn has two SEPARATE sections:
    • PEOPLE SEARCH (linkedin.com/search/results/people/) — finds individual PEOPLE: recruiters, employees, contacts.
    • JOBS (linkedin.com/jobs/) — finds JOB POSTINGS, NOT people.
    When the task asks to FIND PEOPLE (recruiters, employees, contacts), ALWAYS use People search. NEVER go to linkedin.com/jobs for this.
    To search for people: navigate to https://www.linkedin.com/search/results/people/?keywords=<encoded+query>
    Include the company name IN the keywords (e.g. "early technology recruiter Microsoft" → ?keywords=early+technology+recruiter+Microsoft).
    Do NOT add a separate "filter by company" step — including the company in keywords is sufficient and more reliable.
12. LINKEDIN BATCH CONNECT WORKFLOW — For "find N people at Company and send connection requests":
    Step 1: Navigate to https://www.linkedin.com/search/results/people/?keywords=role+company
    Step 2: From the results page, collect the full profile URLs of the first N people visible (list them in the result observations)
    Steps 3 to N+2: For each profile URL — "Send connection to [Name]": navigate to that specific profile URL, click Connect, add note, send.
    Each connect step must have the EXACT profile URL in its description so the executor navigates directly.
13. CONTENT WRITING — If the task is to write an essay, email, cover letter, or any document content:
    Plan ONE step: "Write [content type] in document". The executor will compose the text from
    the user context provided and type it directly using type_text. Do NOT plan to click AI
    buttons like "Write with Gemini" — the executor types content itself.
    For Google Docs: the executor clicks the document body then uses type_text.

=== RETURN FORMAT ===
Return ONLY valid JSON — no markdown, no explanation:
{{"steps": [{{"title": "≤60 chars, action-oriented", "description": "specific instructions + success criteria the executor must verify", "critical": true}}]}}"""

    def _build_step_prompt(
        self,
        step: dict[str, Any],
        payload: dict[str, Any],
        completed: list[dict[str, Any]],
        all_steps: list[dict[str, Any]],
        index: int,
        current_url: str,
        resume_tmp_path: str | None = None,
        live_snapshot: str = "",
    ) -> str:
        goal = str(payload.get("goal") or "").strip()
        user_context = str(payload.get("userContext") or "").strip()
        field_target = payload.get("fieldTarget")
        structured = payload.get("structured")

        # Build completed-step history (rolling window: full observations for last 2 steps only)
        completed_lines: list[str] = []
        total_done = len(completed)
        for ci, c in enumerate(completed):
            s = c.get("step", {})
            r = c.get("result") or {}
            summary = str(r.get("summary") or "done").strip()
            verified = r.get("verified")
            tag = " [✓]" if verified is True else (" [!]" if verified is False else "")
            is_recent = ci >= total_done - 2
            observations = str(r.get("observations") or "").strip() if is_recent else ""
            line = f"  ✓ {s.get('title', '')}: {summary}{tag}"
            if observations:
                line += f"\n    → {observations[:220]}"
            completed_lines.append(line)
        completed_section = (
            "\n=== WHAT HAPPENED SO FAR ===\n"
            + "\n".join(completed_lines)
            if completed_lines else ""
        )

        remaining_lines: list[str] = []
        for j, s in enumerate(all_steps):
            if j > index:
                remaining_lines.append(f"  {j + 1}. {s.get('title', '')}")
        remaining_section = (
            "\n=== UPCOMING STEPS (awareness only — do NOT execute these) ===\n"
            + "\n".join(remaining_lines)
            if remaining_lines else ""
        )

        # Extra context for the executor
        extra_parts: list[str] = []
        if user_context:
            extra_parts.append(f"User context:\n{user_context[:600]}")

        if isinstance(field_target, dict):
            ft_lines: list[str] = ["Target field:"]
            ftype = str(field_target.get("fieldType") or "").strip()
            selector = str(field_target.get("selector") or "").strip()
            char_limit = field_target.get("charLimit")
            if ftype:
                ft_lines.append(f"  type: {ftype}")
            if selector:
                ft_lines.append(f"  selector: {selector}")
            if char_limit:
                ft_lines.append(f"  char limit: {char_limit}")
            extra_parts.append("\n".join(ft_lines))

        if isinstance(structured, dict) and structured:
            extra_parts.append(
                f"Pre-extracted form data (use these values when filling fields):\n"
                f"{json.dumps(structured, ensure_ascii=True)[:800]}"
            )

        if resume_tmp_path:
            resume_name = str(payload.get("resumeFile", {}).get("name") or "resume.pdf") if isinstance(payload.get("resumeFile"), dict) else "resume.pdf"
            extra_parts.append(
                f"Resume file: '{resume_name}' is saved at: {resume_tmp_path}\n"
                f"For file upload inputs: use the upload_file tool or set_file_input_files CDP method with path '{resume_tmp_path}'."
            )

        extra_context = ("\n\n" + "\n\n".join(extra_parts)) if extra_parts else ""

        snapshot_section = (
            f"\n\n=== CURRENT PAGE STATE (live DOM snapshot) ===\n{live_snapshot[:4000]}"
            if live_snapshot
            else ""
        )

        return f"""Execute ONLY this one step. Use Chrome DevTools MCP tools.

=== YOUR STEP ===
Step {index + 1} of {len(all_steps)}: {step.get("title", "")}
{step.get("description", "")}

=== CONTEXT ===
Overall goal: {goal}
Current browser URL: {current_url or "(unknown)"}{extra_context}{completed_section}{remaining_section}{snapshot_section}

=== EXECUTION RULES ===
1. NAVIGATE FIRST (most important) — If this step requires going to a specific URL or site (e.g., "Navigate to Amazon", "Open google.com"), call navigate_page IMMEDIATELY as your very first action. Do NOT call take_snapshot or list_pages first — the current page is irrelevant and looking at it wastes iterations. After navigate_page completes, then take a snapshot to verify you arrived.
2. ACT DIRECTLY — The CURRENT PAGE STATE above shows the live DOM. Use the element UIDs shown there to click/fill/type immediately. Do NOT call take_snapshot or list_pages before acting — you already have the snapshot. Call take_snapshot only AFTER an action to verify the result.
3. OBSTACLES — If you see a cookie banner, GDPR dialog, or modal overlay: dismiss it first, then continue.
4. FORM FILLING — Use fill() for input fields and textareas; fall back to type_text() only if fill() has no effect.
5. VERIFY — After every action, call take_snapshot to confirm the change took effect.
6. RETRY — If an element isn't found in the snapshot: call take_snapshot to refresh, scroll down, look for alternative selectors.
7. SINGLE STEP — Do NOT proceed to the next step. Execute only what is described above.
8. NO INFINITE LOOPS — If you've called take_snapshot or list_pages more than 3 times without performing a navigation, click, or fill, STOP and return status "failed".
9. LINKEDIN PEOPLE vs JOBS — If the step requires finding PEOPLE (recruiters, employees, contacts) and you are on linkedin.com/jobs or any Jobs page, navigate_page immediately to linkedin.com/search/results/people/?keywords=<query> — do NOT search within Jobs.
10. GOOGLE DOCS / CONTENTEDITABLE — Google Docs does NOT use a standard <textarea>. Its editor is a contenteditable div. To type in Google Docs: (a) click the document body area, then (b) use type_text to type. Never use fill() on a Google Docs page — it will fail or target the wrong element. If you see a textarea in the snapshot and the current page is docs.google.com, that textarea is NOT the Google Docs editor — do NOT type into it.
11. EXTENSION UI — The browser extension control panel may appear as a textarea or input at the bottom center of the page. NEVER type into it. Any element with data-tfa-ui is part of the extension, not the website.

=== RETURN ===
Return ONLY valid JSON (no markdown):
{{"summary": "one sentence: what was accomplished", "status": "completed" or "failed", "verified": true or false, "observations": "exactly what you saw — element labels, field names, URL, values, any site quirks; be specific so subsequent steps can use this", "finalUrl": "current URL if this step navigated to a new page"}}

If this step cannot be completed on the current page: return status "failed" with a clear reason in summary."""

    async def _is_content_writing_goal(
        self,
        goal: str,
        page_url: str,
        provider_config: dict[str, Any],
    ) -> bool:
        """Use the LLM to decide whether this goal requires generating text content
        into a document editor (essay, letter, article, email body, etc.).
        Fast single-turn yes/no call — adds ~1 LLM round-trip before planning."""
        llm, _, model = await self.attach_augmented_llm(
            provider_config,
            "You classify user intent. Answer only 'yes' or 'no'. No explanation.",
        )
        response = await llm.generate_str(
            (
                "Does this task require generating and typing substantial text content "
                "(essay, letter, article, email body, report, etc.) into a document editor "
                "or text field on the current page?\n\n"
                f"Task: {goal}\n"
                f"Current page: {page_url}\n\n"
                "Answer 'yes' only if the primary job is composing original text content. "
                "Answer 'no' for navigation, form-filling, searching, clicking, or social actions."
            ),
            RequestParams(
                model=model or None,
                max_iterations=1,
                maxTokens=5,
                temperature=0,
                use_history=False,
            ),
        )
        return response.strip().lower().startswith("yes")

    async def _pre_generate_writing_content(
        self,
        goal: str,
        user_context: str,
        provider_config: dict[str, Any],
    ) -> str:
        """Generate the actual text content that should be typed into the document."""
        llm, _provider, model = await self.attach_augmented_llm(
            provider_config,
            "You are a professional writer. Generate the requested content based on the "
            "information provided. Write ONLY the content itself — no preamble, no instructions, "
            "no explanation. Just the requested document content ready to be pasted.",
        )
        context_block = f"\n\nUser background / context:\n{user_context[:2000]}" if user_context else ""
        prompt = (
            f"Write the following content for a user:\n\n"
            f"Request: {goal}{context_block}\n\n"
            f"Return ONLY the final text content, no markdown formatting, no headings about "
            f"'Here is your essay' — just the raw text ready to type into a document."
        )
        content = await llm.generate_str(
            prompt,
            RequestParams(
                model=model or None,
                max_iterations=1,
                maxTokens=1200,
                temperature=0.7,
                use_history=False,
            ),
        )
        return content.strip()

    async def _generate_plan(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        provider_config = payload.get("providerConfig")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

        goal = str(payload.get("goal") or "").strip()

        live_snapshot = await self._take_planning_snapshot()
        log_runtime(f"[plan] snapshot={'yes' if live_snapshot else 'no'} len={len(live_snapshot)}")

        llm, _provider, model = await self.attach_augmented_llm(
            provider_config,
            PLANNER_SYSTEM_PROMPT,
        )
        prompt = self._build_plan_prompt(payload, live_snapshot)
        # max_iterations=1: PLANNER_SYSTEM_PROMPT prohibits tool calls so the LLM
        # must return JSON in a single turn.  Give 2 iterations as a safety buffer
        # in case the LLM framework adds a mandatory first-turn tool call.
        response = await llm.generate_str(
            prompt,
            RequestParams(
                model=model or None,
                max_iterations=2,
                maxTokens=900,
                temperature=0.1,
                use_history=False,
            ),
        )
        log_runtime(f"[plan] raw_response={truncate_text(response, 400)}")
        try:
            parsed = extract_json_payload(response)
        except Exception:
            # Repair pass: LLM returned narrative — ask it to convert to JSON.
            goal = str(payload.get("goal") or "").strip()
            repair_prompt = (
                f"The previous response did not return valid JSON.\n\n"
                f"Goal: {goal}\n"
                f"Previous response: {json.dumps(response[:1500], ensure_ascii=True)}\n\n"
                f"Return ONLY this JSON (no markdown, no explanation):\n"
                f'{"{"}"steps": [{{"title": "≤60 chars", "description": "specific instructions", "critical": true}}]{"}"}\n\n'
                f"Use 2-6 steps. Each title must start with a verb (Navigate, Search, Click, Fill, Open, Verify)."
            )
            repair_response = await llm.generate_str(
                repair_prompt,
                RequestParams(
                    model=model or None,
                    max_iterations=2,
                    maxTokens=600,
                    temperature=0,
                    use_history=False,
                ),
            )
            try:
                parsed = extract_json_payload(repair_response)
            except Exception:
                return [{"title": "Complete the requested task", "description": str(payload.get("goal") or ""), "critical": True}]
        steps = parsed.get("steps") if isinstance(parsed, dict) else parsed if isinstance(parsed, list) else []
        if not isinstance(steps, list) or not steps:
            return [{"title": "Complete the requested task", "description": str(payload.get("goal") or ""), "critical": True}]
        return [s for s in steps if isinstance(s, dict)][:8]

    async def _execute_step(
        self,
        step: dict[str, Any],
        payload: dict[str, Any],
        completed: list[dict[str, Any]],
        all_steps: list[dict[str, Any]],
        index: int,
        current_url: str,
        resume_tmp_path: str | None = None,
    ) -> dict[str, Any]:
        provider_config = payload.get("providerConfig")
        if not isinstance(provider_config, dict):
            raise RuntimeError("providerConfig is required")

        # LinkedIn connect step: route to the specialized handler that knows
        # the Connect button → Add a note modal → Send flow and all edge cases.
        step_title_lower = str(step.get("title") or "").lower()
        step_description = str(step.get("description") or "")
        is_connect_step = (
            ("connect" in step_title_lower or "connection request" in step_title_lower)
            and "linkedin.com/in/" in step_description
        )
        if is_connect_step:
            profile_url_match = _URL_RE.search(step_description)
            profile_url = (
                profile_url_match.group(0).rstrip(".,)") if profile_url_match else ""
            )
            if profile_url and "linkedin.com/in/" in profile_url:
                # Extract name from step title: "Send Connection to John Doe" → "John Doe"
                raw_name = step.get("title", "")
                for prefix in ("Send Connection to ", "Send connection to ", "Send connection request to ",
                               "Send Connection Request to ", "Connect with ", "connect with "):
                    if raw_name.lower().startswith(prefix.lower()):
                        raw_name = raw_name[len(prefix):]
                        break
                connect_result = await self.execute_linkedin_connect_item(
                    {
                        **payload,
                        "targetUrl": profile_url,
                        "targetName": raw_name.strip() or None,
                    },
                    provider_config,
                )
                if connect_result["outcome"] == "failed":
                    raise RuntimeError(connect_result["summary"])
                return {
                    "summary": connect_result["summary"],
                    "status": "completed",
                    "verified": connect_result["outcome"] in {"sent", "skipped"},
                    "observations": f"finalState={connect_result['finalState']}",
                    "finalUrl": profile_url,
                }

        # Ground truth URL from Chrome — more reliable than tracked current_url,
        # which may be stale if the previous step navigated without setting finalUrl.
        actual_url = await self._get_actual_selected_url() or current_url

        # Pre-navigation guard: if the step explicitly targets a URL and the browser
        # is currently on a different domain, navigate there BEFORE calling the LLM.
        # This prevents observation-loop failures where weak models (Gemini) keep
        # calling take_snapshot / list_pages instead of navigating.
        target_url = _extract_step_target_url(step, actual_url)
        if target_url:
            pages = await self.list_pages(trace=False)
            page_id = pages[0]["pageId"] if pages else None
            if page_id is not None:
                log_runtime(f"[step] pre-navigate url={target_url}")
                try:
                    await self.navigate_page(page_id, target_url)
                    actual_url = target_url
                except Exception as nav_err:
                    log_runtime(f"[step] pre-navigate failed: {nav_err}")

        # Capture the live DOM snapshot once here and embed it in the step prompt.
        # This lets the LLM act on visible element UIDs immediately without wasting
        # iterations on list_pages / select_page / take_snapshot before every action.
        live_snapshot = ""
        try:
            live_snapshot = await self._take_planning_snapshot()
        except Exception:
            pass

        # Writing-step interception: if this step requires typing content into a
        # document editor, pre-generate the text using all available context
        # (goal + user profile + completed step observations) and embed it verbatim
        # in the step description. The executor then only needs to click + type_text.
        # This avoids LLM refusals ("I cannot generate creative content") at execution
        # time and works for multi-step research→write workflows because completed
        # step observations are available here.
        if await self._is_content_writing_goal(
            str(step.get("title", "")) + " " + str(step.get("description", "")),
            actual_url,
            provider_config,
        ):
            try:
                goal_str = str(payload.get("goal") or "").strip()
                user_context = str(payload.get("userContext") or "").strip()
                prior_observations = "\n".join(
                    str(c.get("result", {}).get("observations") or "")
                    + " " + str(c.get("result", {}).get("summary") or "")
                    for c in completed
                    if c.get("result")
                ).strip()
                research_context = (
                    f"\n\nResearch from previous steps:\n{prior_observations[:3000]}"
                    if prior_observations else ""
                )
                content = await self._pre_generate_writing_content(
                    goal_str + research_context, user_context, provider_config
                )
                if content:
                    log_runtime(f"[step] writing interception, pre_generated len={len(content)}")
                    step = {
                        **step,
                        "description": (
                            f"The document editor is on this page. Do NOT call navigate_page.\n"
                            f"1. Call take_snapshot to confirm the editor is visible\n"
                            f"2. Click the document body area to place the cursor\n"
                            f"3. Call type_text to type the following content:\n\n"
                            f"{content}\n\n"
                            f"4. Take a screenshot to verify the text appears."
                        ),
                        "_pre_generated_content": content,
                    }
            except Exception as write_err:
                log_runtime(f"[step] writing interception failed, falling back: {write_err}")

        llm, _, model = await self.attach_augmented_llm(
            provider_config,
            build_effective_system_prompt(
                BASE_AGENT_SYSTEM_PROMPT,
                str(payload.get("systemPrompt") or "").strip() or None,
            ),
        )
        prompt = self._build_step_prompt(
            step, payload, completed, all_steps, index, actual_url,
            resume_tmp_path=resume_tmp_path,
            live_snapshot=live_snapshot,
        )

        response = await llm.generate_str(
            prompt,
            RequestParams(
                model=model or None,
                max_iterations=15,
                maxTokens=1200,
                temperature=0.1,
                use_history=False,
            ),
        )
        try:
            result = extract_json_payload(response)
        except Exception:
            # LLM narrated instead of returning JSON — run a finalization pass.
            page_state = await self.capture_selected_page_state()
            repair_prompt = build_json_finalization_prompt(
                task_label=step.get("title", "step"),
                original_response=response,
                page_url=str(page_state.get("pageUrl") or "").strip() or None,
                page_title=str(page_state.get("pageTitle") or "").strip() or None,
                page_snapshot=str(page_state.get("pageSnapshot") or "").strip() or None,
            )
            repair_response = await llm.generate_str(
                repair_prompt,
                RequestParams(
                    model=model or None,
                    max_iterations=2,
                    maxTokens=500,
                    temperature=0,
                    use_history=False,
                ),
            )
            try:
                result = extract_json_payload(repair_response)
            except Exception:
                result = {"summary": response.strip()[:200] or "Step executed.", "status": "completed"}
        if str(result.get("status") or "").strip().lower() == "failed":
            raise RuntimeError(str(result.get("summary") or "Step failed"))

        # Read the actual Chrome URL after the step — more reliable than the
        # LLM's optional finalUrl which may be omitted for non-navigation steps.
        post_url = await self._get_actual_selected_url()
        if post_url:
            result["_actualFinalUrl"] = post_url
        return result

    async def execute_with_explicit_plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        run_id = str(payload.get("runId") or "").strip()
        self._cancelled = False

        # Write the resume to a temp file once — pass the path to every step.
        # Avoids re-decoding base64 on every step that might need it.
        resume_tmp_path: str | None = None
        resume_file = payload.get("resumeFile")
        if isinstance(resume_file, dict) and resume_file.get("base64"):
            resume_tmp_path = write_resume_to_temp(resume_file)

        self._emit_progress({"event": "planning", "runId": run_id})
        plan_steps = await self._generate_plan(payload)
        self._emit_progress({
            "event": "plan_ready",
            "runId": run_id,
            "steps": [
                {"title": s.get("title", ""), "description": s.get("description", "")}
                for s in plan_steps
            ],
        })

        completed: list[dict[str, Any]] = []
        current_url = str(payload.get("pageUrl") or "").strip()

        for i, step in enumerate(plan_steps):
            if self._cancelled:
                raise asyncio.CancelledError("Run was cancelled by user")

            self._emit_progress({
                "event": "step_started", "runId": run_id, "index": i,
                "title": step.get("title", ""),
            })
            step_result: dict[str, Any] | None = None
            last_error: str | None = None

            for attempt in range(3):
                if self._cancelled:
                    raise asyncio.CancelledError("Run was cancelled by user")
                try:
                    step_result = await self._execute_step(
                        step, payload, completed, plan_steps, i, current_url,
                        resume_tmp_path=resume_tmp_path,
                    )
                    last_error = None
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    last_error = str(exc)
                    if attempt < 2:
                        self._emit_progress({
                            "event": "step_retrying", "runId": run_id, "index": i,
                            "error": last_error, "attempt": attempt + 1,
                        })
                        await asyncio.sleep(2 ** attempt * 2)

            if last_error:
                is_critical = bool(step.get("critical", True))
                self._emit_progress({
                    "event": "step_failed", "runId": run_id, "index": i,
                    "error": last_error, "skipped": not is_critical,
                })
                if is_critical:
                    raise RuntimeError(f"Step '{step.get('title', '')}' failed: {last_error}")
                step_result = {"summary": f"Skipped: {last_error}", "status": "skipped"}
            else:
                # Prefer actual Chrome URL over the LLM's optional finalUrl field.
                step_actual_url = (
                    str(step_result.get("_actualFinalUrl") or step_result.get("finalUrl") or "")
                    if step_result else ""
                )
                if step_actual_url:
                    current_url = step_actual_url
                verified = step_result.get("verified") if step_result else None
                observations = str(step_result.get("observations") or "") if step_result else ""
                self._emit_progress({
                    "event": "step_completed", "runId": run_id, "index": i,
                    "summary": str(step_result.get("summary") or "") if step_result else "",
                    "status": str(step_result.get("status") or "completed") if step_result else "completed",
                    "verified": verified,
                    "observations": observations,
                })

                # Dynamic plan injection: if this step collected LinkedIn profile URLs,
                # replace any remaining generic "send connection" placeholders with one
                # concrete step per URL so all N targets get processed.
                if step_result:
                    result_text = observations + " " + str(step_result.get("summary") or "")
                    # For collect/search/find steps, also scan the live page snapshot
                    # because the LLM may only mention a subset of URLs in its summary.
                    step_title_lower = str(step.get("title") or "").lower()
                    if any(kw in step_title_lower for kw in ("collect", "gather", "find", "search", "list", "scrape")):
                        try:
                            fresh_snap = await self._take_planning_snapshot()
                            result_text += " " + fresh_snap
                        except Exception:
                            pass
                    collected_urls = _extract_linkedin_profile_urls(result_text)
                    if collected_urls:
                        goal = str(payload.get("goal") or "")
                        # Remove any not-yet-started generic connect placeholder steps.
                        remaining_generic = [
                            j for j, s in enumerate(plan_steps)
                            if j > i and not s.get("_injected")
                            and ("connect" in str(s.get("title") or "").lower()
                                 or "connection" in str(s.get("title") or "").lower())
                            and "linkedin.com/in/" not in str(s.get("description") or "")
                        ]
                        for j in sorted(remaining_generic, reverse=True):
                            plan_steps.pop(j)
                        # Inject one step per collected URL after current position.
                        inject_at = i + 1
                        for k, url in enumerate(collected_urls):
                            label = f"({k + 1}/{len(collected_urls)})"
                            plan_steps.insert(inject_at + k, _build_connect_step(url, goal, label))
                        if collected_urls:
                            self._emit_progress({
                                "event": "plan_updated",
                                "runId": run_id,
                                "steps": [
                                    {"title": s.get("title", ""), "description": s.get("description", "")}
                                    for s in plan_steps
                                ],
                            })

            completed.append({"step": step, "result": step_result})

        step_summaries = [
            str(c.get("result", {}).get("summary") or "") for c in completed
            if c.get("result", {}).get("summary") and
               str(c.get("result", {}).get("status") or "completed") != "skipped"
        ]
        overall_summary = (
            step_summaries[-1] if len(step_summaries) == 1
            else (" → ".join(step_summaries) if step_summaries else "Task completed.")
        )

        metadata: dict[str, Any] = {"kind": "execute_agent_task", "status": "completed"}
        if current_url:
            metadata["finalUrl"] = current_url
        return {"summary": overall_summary, "metadata": metadata}

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
        target_name = str(item.get("targetName") or "").strip()
        if not target_url:
            raise RuntimeError("LinkedIn batch item targetUrl is required")

        page = await self.focus_or_open_page(target_url)
        preserve_page = False

        try:
            await self.wait_for_page_ready(page["pageId"], 15000)

            # Detect 404 / profile-not-found before spending LLM iterations.
            # LinkedIn 404 pages have "Page Not Found" in the title or redirect to
            # linkedin.com/404 or linkedin.com/in/*/recent-activity/... with a
            # profile-unavailable message.
            try:
                page_title_raw = await self.evaluate_on_page(
                    page_id=page["pageId"],
                    function_source="() => document.title || ''",
                )
                page_title_lower = str(page_title_raw or "").strip().lower()
                pages_list = await self.list_pages()
                actual_url = next(
                    (p.get("url", "") for p in pages_list if p.get("pageId") == page["pageId"]),
                    "",
                )
                is_404 = (
                    "page not found" in page_title_lower
                    or "/404" in str(actual_url)
                    or "unavailable" in page_title_lower
                )
                if is_404:
                    # Fall back: search for the person by name on LinkedIn
                    if target_name:
                        search_url = (
                            "https://www.linkedin.com/search/results/people/?keywords="
                            + "+".join(target_name.split())
                        )
                        log_runtime(f"[connect] profile 404, falling back to name search: {search_url}")
                        await self.navigate_page(page["pageId"], search_url)
                        await self.wait_for_page_ready(page["pageId"], 12000)
                        item = {
                            **item,
                            "targetUrl": search_url,
                            "pageContext": (
                                f"Profile URL was not found (404). "
                                f"Now showing LinkedIn search results for '{target_name}'. "
                                f"Find this person in the results and click their profile, "
                                f"then send the connection request from their profile page."
                            ),
                        }
                    else:
                        return {
                            "outcome": "skipped",
                            "finalState": "profile_not_found",
                            "summary": f"Profile page returned 404 and no name was available to search.",
                            "preservedPage": False,
                        }
            except Exception as e404:
                log_runtime(f"[connect] 404 check error (ignored): {e404}")
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

        # LinkedIn profile connect: use the specialized flow that knows how to
        # handle the Connect → Add a note modal, already-connected, already-pending,
        # and connect-button-not-found edge cases reliably.
        if is_linkedin_profile_connect_goal(payload):
            target_url = str(payload.get("pageUrl") or "").strip()
            if not target_url:
                raise RuntimeError("A LinkedIn profile URL is required for connect tasks.")
            connect_result = await self.execute_linkedin_connect_item(
                {
                    **payload,
                    "targetUrl": target_url,
                    "targetName": extract_linkedin_target_name(payload),
                },
                provider_config,
            )
            if connect_result["outcome"] == "failed":
                raise RuntimeError(connect_result["summary"])
            return {
                "summary": connect_result["summary"],
                "status": "completed",
                "taskType": "linkedin_profile_connect",
                "finalState": connect_result["finalState"],
                "preservedPage": connect_result["preservedPage"],
            }

        return await self.execute_with_explicit_plan(payload)


async def run_runtime() -> None:
    direct_app = MCPApp(
        name="cheatresume_python_browser_runtime",
        settings=build_runtime_settings(),
    )

    async with direct_app.run():
        agent = Agent(
            name="chrome_runtime",
            server_names=["chrome-devtools"],
            context=direct_app.context,
        )

        async with agent:
            runtime = PythonBrowserRuntime(agent, app=direct_app)
            while True:
                request_id = "unknown"
                try:
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
                        write_response({"id": request_id, "ok": True, "result": {"ok": True}})
                        return

                    if method == "health":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.health())})
                        continue

                    if method == "derive_browser_work_items":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.derive_browser_work_items(args))})
                        continue

                    if method == "navigate_to_url":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.navigate_to_url(args))})
                        continue

                    if method == "insert_draft":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.insert_draft(args))})
                        continue

                    if method == "execute_linkedin_connect_batch":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.execute_linkedin_connect_batch(args))})
                        continue

                    if method == "execute_agent_task":
                        write_response({"id": request_id, "ok": True, "result": serialize_result(await runtime.execute_agent_task(args))})
                        continue

                    raise ValueError(f"Unsupported runtime method: {method}")
                except Exception as error:
                    write_response({"id": request_id, "ok": False, "error": normalize_error_message(error)})


def main() -> None:
    try:
        asyncio.run(run_runtime())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
