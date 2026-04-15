#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp_agent.agents.agent import Agent
from mcp_agent.app import MCPApp
from mcp_agent.config import LoggerSettings, MCPServerSettings, MCPSettings, Settings


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
        key: value
        for key, value in os.environ.items()
        if isinstance(value, str)
    }

    return Settings(
        name="cheatresume_mcp_agent_bridge",
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


def serialize_payload(payload: Any) -> Any:
    if hasattr(payload, "model_dump"):
        return payload.model_dump(mode="json")
    if hasattr(payload, "dict"):
        return payload.dict()
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, list):
        return [serialize_payload(item) for item in payload]
    return payload


async def read_request_line() -> str:
    return await asyncio.to_thread(sys.stdin.readline)


def write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


async def run_bridge() -> None:
    app = MCPApp(
        name="cheatresume_mcp_agent_bridge",
        settings=build_settings(),
    )

    async with app.run():
        agent = Agent(
            name="chrome_runtime",
            server_names=["chrome-devtools"],
            context=app.context,
        )

        async with agent:
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

                    if method == "shutdown":
                        write_response({"id": request_id, "ok": True, "result": {"ok": True}})
                        return

                    if method == "health":
                        result = await agent.call_tool(
                            "list_pages",
                            {},
                            server_name="chrome-devtools",
                        )
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_payload(result),
                            }
                        )
                        continue

                    if method == "call_tool":
                        tool_name = request.get("toolName")
                        if not isinstance(tool_name, str) or not tool_name.strip():
                            raise ValueError("toolName is required")
                        tool_args = request.get("args")
                        if not isinstance(tool_args, dict):
                            tool_args = {}
                        result = await agent.call_tool(
                            tool_name,
                            tool_args,
                            server_name="chrome-devtools",
                        )
                        write_response(
                            {
                                "id": request_id,
                                "ok": True,
                                "result": serialize_payload(result),
                            }
                        )
                        continue

                    raise ValueError(f"Unsupported bridge method: {method}")
                except Exception as error:
                    write_response(
                        {
                            "id": request_id,
                            "ok": False,
                            "error": str(error),
                        }
                    )


def main() -> None:
    try:
        asyncio.run(run_bridge())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
