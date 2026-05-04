#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

from temporalio.testing import WorkflowEnvironment


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error


async def run_server() -> None:
    host = os.getenv("LOCAL_COMPANION_TEMPORAL_HOST", "").strip() or "127.0.0.1"
    port = env_int("LOCAL_COMPANION_TEMPORAL_PORT", 7233)
    namespace = (
        os.getenv("LOCAL_COMPANION_TEMPORAL_NAMESPACE", "").strip() or "default"
    )
    database_path = (
        os.getenv("LOCAL_COMPANION_TEMPORAL_DB_FILE", "").strip()
        or "companion/.data/temporal/dev-server.db"
    )
    ui_enabled = os.getenv("LOCAL_COMPANION_TEMPORAL_UI", "0").strip() == "1"
    ui_port = env_int("LOCAL_COMPANION_TEMPORAL_UI_PORT", 8233)
    log_level = os.getenv("LOCAL_COMPANION_TEMPORAL_LOG_LEVEL", "").strip() or "warn"

    db_file = Path(database_path)
    db_file.parent.mkdir(parents=True, exist_ok=True)

    environment = await WorkflowEnvironment.start_local(
        namespace=namespace,
        ip=host,
        port=port,
        ui=ui_enabled,
        ui_port=ui_port if ui_enabled else None,
        dev_server_database_filename=str(db_file),
        dev_server_log_level=log_level,
    )

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_args: stop_event.set())

    print(
        f"[temporal-dev-server] listening on {host}:{port} namespace={namespace}",
        flush=True,
    )
    if ui_enabled:
        print(
            f"[temporal-dev-server] ui on http://{host}:{ui_port}",
            flush=True,
        )

    try:
        await stop_event.wait()
    finally:
        await environment.shutdown()


def main() -> None:
    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"[temporal-dev-server] fatal: {error}", file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    main()
