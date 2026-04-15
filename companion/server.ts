import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LocalCompanionRequestEnvelope,
  LocalCompanionResponseEnvelope,
} from "../src/lib/local-agent-protocol.ts";
import { LocalAgentCompanionService } from "./service.ts";
import {
  createCompanionLogger,
  getDefaultCompanionLogFilePath,
} from "./live-logger.ts";
import { ChromeDevtoolsMcpRuntime } from "./chrome-devtools-mcp-runtime.ts";

type RequestPayload = LocalCompanionRequestEnvelope<Record<string, unknown>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writePidFile(pidFilePath: string | undefined): void {
  if (!pidFilePath) {
    return;
  }
  mkdirSync(dirname(pidFilePath), { recursive: true });
  writeFileSync(pidFilePath, `${process.pid}\n`, "utf8");
}

function removePidFile(pidFilePath: string | undefined): void {
  if (!pidFilePath) {
    return;
  }
  rmSync(pidFilePath, { force: true });
}

async function dispatchRequest(
  service: LocalAgentCompanionService,
  request: RequestPayload
): Promise<unknown> {
  switch (request.method) {
    case "health":
      return service.getHealth();
    case "get_panel_state":
      return service.getPanelState({
        userScope: String(request.params?.userScope ?? ""),
        limit: Number(request.params?.limit ?? 5),
      });
    case "start_run":
      return service.startRun({
        userScope: String(request.params?.userScope ?? ""),
        goal: String(request.params?.goal ?? ""),
        ...(typeof request.params?.platformHint === "string"
          ? { platformHint: request.params.platformHint }
          : {}),
        ...(typeof request.params?.pageUrl === "string"
          ? { pageUrl: request.params.pageUrl }
          : {}),
        ...(typeof request.params?.pageContext === "string"
          ? { pageContext: request.params.pageContext }
          : {}),
        ...(request.params?.fieldTarget &&
        typeof request.params.fieldTarget === "object"
          ? { fieldTarget: request.params.fieldTarget as any }
          : {}),
        ...(Array.isArray(request.params?.scannedCandidates)
          ? { scannedCandidates: request.params.scannedCandidates as any }
          : {}),
        ...(typeof request.params?.nextPageUrl === "string" ||
        request.params?.nextPageUrl === null
          ? { nextPageUrl: request.params.nextPageUrl as string | null }
          : {}),
        ...(request.params?.structured &&
        typeof request.params.structured === "object"
          ? { structured: request.params.structured as any }
          : {}),
        ...(request.params?.providerConfig &&
        typeof request.params.providerConfig === "object"
          ? { providerConfig: request.params.providerConfig as any }
          : {}),
      });
    case "resolve_approval":
      return service.resolveApproval({
        userScope: String(request.params?.userScope ?? ""),
        approvalId: String(request.params?.approvalId ?? ""),
        decision:
          request.params?.decision === "rejected" ? "rejected" : "approved",
        ...(typeof request.params?.decisionNote === "string"
          ? { decisionNote: request.params.decisionNote }
          : {}),
        ...(request.params?.providerConfig &&
        typeof request.params.providerConfig === "object"
          ? { providerConfig: request.params.providerConfig as any }
          : {}),
      });
    case "report_action_result":
      return service.reportActionResult({
        userScope: String(request.params?.userScope ?? ""),
        approvalId: String(request.params?.approvalId ?? ""),
        succeeded: request.params?.succeeded === true,
        ...(typeof request.params?.summary === "string"
          ? { summary: request.params.summary }
          : {}),
        ...(typeof request.params?.errorMessage === "string"
          ? { errorMessage: request.params.errorMessage }
          : {}),
        ...(request.params?.metadata &&
        typeof request.params.metadata === "object"
          ? { metadata: request.params.metadata as Record<string, unknown> }
          : {}),
      });
  }
}

export function startLocalCompanionServer(options?: {
  port?: number;
  host?: string;
}): {
  server: WebSocketServer;
  dispose: () => Promise<void>;
} {
  const port = options?.port ?? Number(process.env.LOCAL_COMPANION_PORT ?? 4315);
  const host = options?.host ?? process.env.LOCAL_COMPANION_HOST ?? "127.0.0.1";
  const pidFilePath = process.env.LOCAL_COMPANION_PID_FILE?.trim() || undefined;
  const logger = createCompanionLogger(getDefaultCompanionLogFilePath());
  const service = new LocalAgentCompanionService(
    undefined,
    new ChromeDevtoolsMcpRuntime({ logger }),
    logger
  );
  const server = new WebSocketServer({
    host,
    port,
    path: "/ws",
  });

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", async (data: RawData) => {
      let request: RequestPayload;
      try {
        request = JSON.parse(String(data)) as RequestPayload;
      } catch (error) {
        logger.event("error", "server", "invalid_json", {
          message: errorMessage(error),
        });
        const response: LocalCompanionResponseEnvelope = {
          type: "response",
          requestId: "invalid",
          ok: false,
          error: {
            code: "invalid_json",
            message: errorMessage(error),
          },
        };
        socket.send(JSON.stringify(response));
        socket.close();
        return;
      }

      logger.event("info", "server", "request", {
        requestId: request.requestId,
        method: request.method,
      });
      try {
        const result = await dispatchRequest(service, request);
        logger.event("info", "server", "response_ok", {
          requestId: request.requestId,
          method: request.method,
        });
        const response: LocalCompanionResponseEnvelope = {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result,
        };
        socket.send(JSON.stringify(response));
      } catch (error) {
        logger.event("error", "server", "response_error", {
          requestId: request.requestId,
          method: request.method,
          message: errorMessage(error),
        });
        const response: LocalCompanionResponseEnvelope = {
          type: "response",
          requestId: request.requestId,
          ok: false,
          error: {
            code: "request_failed",
            message: errorMessage(error),
          },
        };
        socket.send(JSON.stringify(response));
      } finally {
        socket.close();
      }
    });
  });

  logger.log(`[local-companion] listening on ws://${host}:${port}/ws`);
  logger.log(`[local-companion] live log at ${logger.filePath}`);
  logger.event("info", "server", "listening", {
    wsUrl: `ws://${host}:${port}/ws`,
    logFilePath: logger.filePath,
    pid: process.pid,
    ...(pidFilePath ? { pidFilePath } : {}),
  });
  writePidFile(pidFilePath);

  let closed = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    removePidFile(pidFilePath);
    await service.dispose();
  };
  server.on("close", () => {
    if (closed) {
      return;
    }
    closed = true;
    logger.event("info", "server", "closing");
    void dispose();
  });

  return {
    server,
    dispose,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, dispose } = startLocalCompanionServer();
  let shuttingDownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shuttingDownPromise) {
      return;
    }
    shuttingDownPromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
      .catch(() => {
        // Ignore close errors during shutdown and still dispose the runtime.
      })
      .then(async () => {
        await dispose();
      })
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error("[local-companion] shutdown failed", error);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
