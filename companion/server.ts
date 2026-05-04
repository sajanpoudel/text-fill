import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LocalCompanionCancelRunParams,
  LocalCompanionMethod,
  LocalCompanionReportActionResultParams,
  LocalCompanionRequestEnvelope,
  LocalCompanionResolveApprovalParams,
  LocalCompanionResumeRunParams,
  LocalCompanionResponseEnvelope,
  LocalCompanionStartRunParams,
  LocalCompanionStructuredExtraction,
  LocalCompanionFieldTarget,
  LocalCompanionCandidateScanItem,
  LocalCompanionBrowserWorkItem,
  LocalCompanionProviderConfig,
  ResumeFileData,
} from "../src/lib/local-agent-protocol.ts";
import { LocalAgentCompanionService } from "./service.ts";
import {
  createCompanionLogger,
  getDefaultCompanionLogFilePath,
} from "./live-logger.ts";
import { ChromeDevtoolsMcpRuntime } from "./chrome-devtools-mcp-runtime.ts";

type RequestParams = Record<string, unknown>;
type PanelStateParams = {
  userScope: string;
  limit: number;
};
type ParsedRequestPayload =
  | {
      type: "request";
      requestId: string;
      method: "health";
      params: Record<string, never>;
    }
  | {
      type: "request";
      requestId: string;
      method: "get_panel_state";
      params: PanelStateParams;
    }
  | {
      type: "request";
      requestId: string;
      method: "start_run";
      params: LocalCompanionStartRunParams;
    }
  | {
      type: "request";
      requestId: string;
      method: "cancel_run";
      params: LocalCompanionCancelRunParams;
    }
  | {
      type: "request";
      requestId: string;
      method: "resume_run";
      params: LocalCompanionResumeRunParams;
    }
  | {
      type: "request";
      requestId: string;
      method: "resolve_approval";
      params: LocalCompanionResolveApprovalParams;
    }
  | {
      type: "request";
      requestId: string;
      method: "report_action_result";
      params: LocalCompanionReportActionResultParams;
    };

const COMPANION_METHODS: readonly LocalCompanionMethod[] = [
  "health",
  "get_panel_state",
  "start_run",
  "cancel_run",
  "resume_run",
  "resolve_approval",
  "report_action_result",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is RequestParams {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompanionMethod(value: unknown): value is LocalCompanionMethod {
  return (
    typeof value === "string" &&
    COMPANION_METHODS.includes(value as LocalCompanionMethod)
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported request method: ${String(value)}`);
}

export class InvalidCompanionRequestError extends Error {
  readonly code = "invalid_request";
}

function expectRequestObject(
  value: unknown,
  fieldName: string
): RequestParams {
  if (!isPlainObject(value)) {
    throw new InvalidCompanionRequestError(`${fieldName} must be an object.`);
  }
  return value;
}

function parseRequiredString(
  params: RequestParams,
  fieldName: string
): string {
  const value = params[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCompanionRequestError(
      `${fieldName} must be a non-empty string.`
    );
  }
  return value;
}

function parseOptionalString(
  params: RequestParams,
  fieldName: string
): string | undefined {
  const value = params[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidCompanionRequestError(`${fieldName} must be a string.`);
  }
  return value;
}

function parseOptionalNullableString(
  params: RequestParams,
  fieldName: string
): string | null | undefined {
  const value = params[fieldName];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new InvalidCompanionRequestError(
      `${fieldName} must be a string or null.`
    );
  }
  return value;
}

function parseOptionalFiniteNumber(
  params: RequestParams,
  fieldName: string
): number | undefined {
  const value = params[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidCompanionRequestError(
      `${fieldName} must be a finite number.`
    );
  }
  return value;
}

function parseOptionalBoolean(
  params: RequestParams,
  fieldName: string
): boolean | undefined {
  const value = params[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new InvalidCompanionRequestError(`${fieldName} must be a boolean.`);
  }
  return value;
}

function parseFieldTarget(value: unknown): LocalCompanionFieldTarget {
  const objectValue = expectRequestObject(value, "fieldTarget");
  return {
    selector: parseRequiredString(objectValue, "selector"),
    ...(parseOptionalString(objectValue, "platform")
      ? { platform: parseOptionalString(objectValue, "platform") }
      : {}),
    ...(parseOptionalString(objectValue, "fieldType")
      ? { fieldType: parseOptionalString(objectValue, "fieldType") }
      : {}),
    ...(parseOptionalFiniteNumber(objectValue, "charLimit") !== undefined
      ? { charLimit: parseOptionalFiniteNumber(objectValue, "charLimit") }
      : {}),
  };
}

function parseStructuredExtraction(
  value: unknown
): LocalCompanionStructuredExtraction {
  const objectValue = expectRequestObject(value, "structured");
  const data = objectValue.data;
  const matchedFields = objectValue.matchedFields;
  const unmatchedFields = objectValue.unmatchedFields;
  const headings = objectValue.headings;
  return {
    ...(data !== undefined
      ? { data: expectRequestObject(data, "structured.data") }
      : {}),
    ...(Array.isArray(matchedFields) &&
    matchedFields.every((item) => typeof item === "string")
      ? { matchedFields: [...matchedFields] }
      : matchedFields === undefined
        ? {}
        : (() => {
            throw new InvalidCompanionRequestError(
              "structured.matchedFields must be a string array."
            );
          })()),
    ...(Array.isArray(unmatchedFields) &&
    unmatchedFields.every((item) => typeof item === "string")
      ? { unmatchedFields: [...unmatchedFields] }
      : unmatchedFields === undefined
        ? {}
        : (() => {
            throw new InvalidCompanionRequestError(
              "structured.unmatchedFields must be a string array."
            );
          })()),
    ...(Array.isArray(headings) && headings.every((item) => typeof item === "string")
      ? { headings: [...headings] }
      : headings === undefined
        ? {}
        : (() => {
            throw new InvalidCompanionRequestError(
              "structured.headings must be a string array."
            );
          })()),
    ...(parseOptionalString(objectValue, "text")
      ? { text: parseOptionalString(objectValue, "text") }
      : {}),
  };
}

function parseCandidateScanItems(
  value: unknown
): LocalCompanionCandidateScanItem[] {
  if (!Array.isArray(value)) {
    throw new InvalidCompanionRequestError(
      "scannedCandidates must be an array."
    );
  }
  return value.map((item, index) => {
    const objectValue = expectRequestObject(
      item,
      `scannedCandidates[${index}]`
    );
    return {
      targetName: parseRequiredString(objectValue, "targetName"),
      targetUrl: parseRequiredString(objectValue, "targetUrl"),
      ...(parseOptionalString(objectValue, "headline")
        ? { headline: parseOptionalString(objectValue, "headline") }
        : {}),
    };
  });
}

function parseBrowserWorkItems(value: unknown): LocalCompanionBrowserWorkItem[] {
  if (!Array.isArray(value)) {
    throw new InvalidCompanionRequestError("workItems must be an array.");
  }
  return value.map((item, index) => {
    const objectValue = expectRequestObject(item, `workItems[${index}]`);
    return {
      title: parseRequiredString(objectValue, "title"),
      ...(parseOptionalString(objectValue, "pageUrl")
        ? { pageUrl: parseOptionalString(objectValue, "pageUrl") }
        : {}),
      ...(parseOptionalString(objectValue, "targetUrl")
        ? { targetUrl: parseOptionalString(objectValue, "targetUrl") }
        : {}),
      ...(parseOptionalString(objectValue, "targetName")
        ? { targetName: parseOptionalString(objectValue, "targetName") }
        : {}),
      ...(parseOptionalString(objectValue, "itemGoal")
        ? { itemGoal: parseOptionalString(objectValue, "itemGoal") }
        : {}),
      ...(parseOptionalString(objectValue, "itemContext")
        ? { itemContext: parseOptionalString(objectValue, "itemContext") }
        : {}),
      ...(parseOptionalString(objectValue, "sourceType")
        ? { sourceType: parseOptionalString(objectValue, "sourceType") }
        : {}),
    };
  });
}

function parseProviderConfig(value: unknown): LocalCompanionProviderConfig {
  const objectValue = expectRequestObject(value, "providerConfig");
  return {
    provider: parseRequiredString(objectValue, "provider"),
    apiKey: parseRequiredString(objectValue, "apiKey"),
    model: parseRequiredString(objectValue, "model"),
  };
}

function parseResumeFileData(value: unknown): ResumeFileData {
  const objectValue = expectRequestObject(value, "resumeFile");
  return {
    name: parseRequiredString(objectValue, "name"),
    mimeType: parseRequiredString(objectValue, "mimeType"),
    base64: parseRequiredString(objectValue, "base64"),
  };
}

export function parseRequestEnvelope(
  rawRequest: unknown
): ParsedRequestPayload {
  const request = expectRequestObject(rawRequest, "request");
  if (request.type !== "request") {
    throw new InvalidCompanionRequestError("type must be 'request'.");
  }
  if (typeof request.requestId !== "string" || request.requestId.trim().length === 0) {
    throw new InvalidCompanionRequestError(
      "requestId must be a non-empty string."
    );
  }
  if (!isCompanionMethod(request.method)) {
    throw new InvalidCompanionRequestError("method is not supported.");
  }

  const params =
    request.params === undefined ? {} : expectRequestObject(request.params, "params");
  switch (request.method) {
    case "health":
      return {
        type: "request",
        requestId: request.requestId,
        method: "health",
        params: {},
      };
    case "get_panel_state":
      return {
        type: "request",
        requestId: request.requestId,
        method: "get_panel_state",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          limit: parseOptionalFiniteNumber(params, "limit") ?? 5,
        },
      };
    case "start_run":
      return {
        type: "request",
        requestId: request.requestId,
        method: "start_run",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          goal: parseRequiredString(params, "goal"),
          ...(parseOptionalString(params, "platformHint")
            ? { platformHint: parseOptionalString(params, "platformHint") }
            : {}),
          ...(parseOptionalString(params, "pageUrl")
            ? { pageUrl: parseOptionalString(params, "pageUrl") }
            : {}),
          ...(parseOptionalString(params, "pageContext")
            ? { pageContext: parseOptionalString(params, "pageContext") }
            : {}),
          ...(parseOptionalString(params, "userContext")
            ? { userContext: parseOptionalString(params, "userContext") }
            : {}),
          ...(parseOptionalString(params, "systemPrompt")
            ? { systemPrompt: parseOptionalString(params, "systemPrompt") }
            : {}),
          ...(params.fieldTarget !== undefined
            ? { fieldTarget: parseFieldTarget(params.fieldTarget) }
            : {}),
          ...(params.scannedCandidates !== undefined
            ? { scannedCandidates: parseCandidateScanItems(params.scannedCandidates) }
            : {}),
          ...(params.workItems !== undefined
            ? { workItems: parseBrowserWorkItems(params.workItems) }
            : {}),
          ...(parseOptionalNullableString(params, "nextPageUrl") !== undefined
            ? { nextPageUrl: parseOptionalNullableString(params, "nextPageUrl") }
            : {}),
          ...(params.structured !== undefined
            ? {
                structured:
                  params.structured === null
                    ? null
                    : parseStructuredExtraction(params.structured),
              }
            : {}),
          ...(params.providerConfig !== undefined
            ? {
                providerConfig:
                  params.providerConfig === null
                    ? null
                    : parseProviderConfig(params.providerConfig),
              }
            : {}),
          ...(params.resumeFile !== undefined
            ? {
                resumeFile:
                  params.resumeFile === null
                    ? null
                    : parseResumeFileData(params.resumeFile),
              }
            : {}),
        },
      };
    case "cancel_run":
      return {
        type: "request",
        requestId: request.requestId,
        method: "cancel_run",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          runId: parseRequiredString(params, "runId"),
        },
      };
    case "resume_run":
      return {
        type: "request",
        requestId: request.requestId,
        method: "resume_run",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          runId: parseRequiredString(params, "runId"),
          ...(parseOptionalString(params, "pageUrl")
            ? { pageUrl: parseOptionalString(params, "pageUrl") }
            : {}),
          ...(parseOptionalString(params, "pageContext")
            ? { pageContext: parseOptionalString(params, "pageContext") }
            : {}),
          ...(parseOptionalString(params, "userContext")
            ? { userContext: parseOptionalString(params, "userContext") }
            : {}),
          ...(parseOptionalString(params, "systemPrompt")
            ? { systemPrompt: parseOptionalString(params, "systemPrompt") }
            : {}),
          ...(params.fieldTarget !== undefined
            ? { fieldTarget: parseFieldTarget(params.fieldTarget) }
            : {}),
          ...(params.scannedCandidates !== undefined
            ? { scannedCandidates: parseCandidateScanItems(params.scannedCandidates) }
            : {}),
          ...(params.workItems !== undefined
            ? { workItems: parseBrowserWorkItems(params.workItems) }
            : {}),
          ...(parseOptionalNullableString(params, "nextPageUrl") !== undefined
            ? { nextPageUrl: parseOptionalNullableString(params, "nextPageUrl") }
            : {}),
          ...(params.structured !== undefined
            ? {
                structured:
                  params.structured === null
                    ? null
                    : parseStructuredExtraction(params.structured),
              }
            : {}),
          ...(params.providerConfig !== undefined
            ? {
                providerConfig:
                  params.providerConfig === null
                    ? null
                    : parseProviderConfig(params.providerConfig),
              }
            : {}),
          ...(params.resumeFile !== undefined
            ? {
                resumeFile:
                  params.resumeFile === null
                    ? null
                    : parseResumeFileData(params.resumeFile),
              }
            : {}),
        },
      };
    case "resolve_approval":
      return {
        type: "request",
        requestId: request.requestId,
        method: "resolve_approval",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          approvalId: parseRequiredString(params, "approvalId"),
          decision:
            params.decision === "approved" || params.decision === "rejected"
              ? params.decision
              : (() => {
                  throw new InvalidCompanionRequestError(
                    "decision must be 'approved' or 'rejected'."
                  );
                })(),
          ...(parseOptionalString(params, "decisionNote")
            ? { decisionNote: parseOptionalString(params, "decisionNote") }
            : {}),
          ...(params.providerConfig !== undefined
            ? {
                providerConfig:
                  params.providerConfig === null
                    ? null
                    : parseProviderConfig(params.providerConfig),
              }
            : {}),
        },
      };
    case "report_action_result":
      return {
        type: "request",
        requestId: request.requestId,
        method: "report_action_result",
        params: {
          userScope: parseRequiredString(params, "userScope"),
          approvalId: parseRequiredString(params, "approvalId"),
          succeeded: parseOptionalBoolean(params, "succeeded") ?? false,
          ...(parseOptionalString(params, "summary")
            ? { summary: parseOptionalString(params, "summary") }
            : {}),
          ...(parseOptionalString(params, "errorMessage")
            ? { errorMessage: parseOptionalString(params, "errorMessage") }
            : {}),
          ...(params.metadata !== undefined
            ? { metadata: expectRequestObject(params.metadata, "metadata") }
            : {}),
        },
      };
    default:
      return assertNever(request.method);
  }
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

function sendResponse(socket: WebSocket, response: LocalCompanionResponseEnvelope): void {
  socket.send(JSON.stringify(response));
}

async function dispatchRequest(
  service: LocalAgentCompanionService,
  request: ParsedRequestPayload
): Promise<unknown> {
  switch (request.method) {
    case "health":
      return service.getHealth();
    case "get_panel_state":
      return service.getPanelState(request.params);
    case "start_run":
      return service.startRun(request.params);
    case "cancel_run":
      return service.cancelRun(request.params);
    case "resume_run":
      return service.resumeRun(request.params);
    case "resolve_approval":
      return service.resolveApproval(request.params);
    case "report_action_result":
      return service.reportActionResult(request.params);
    default:
      return assertNever(request);
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
      let request: ParsedRequestPayload;
      let rawRequest: unknown;
      try {
        rawRequest = JSON.parse(String(data)) as unknown;
      } catch (error) {
        logger.event("error", "server", "invalid_json", {
          message: errorMessage(error),
        });
        sendResponse(socket, {
          type: "response",
          requestId: "invalid",
          ok: false,
          error: {
            code: "invalid_json",
            message: errorMessage(error),
          },
        });
        socket.close();
        return;
      }

      try {
        request = parseRequestEnvelope(rawRequest);
      } catch (error) {
        logger.event("error", "server", "invalid_request", {
          message: errorMessage(error),
        });
        sendResponse(socket, {
          type: "response",
          requestId:
            isPlainObject(rawRequest) && typeof rawRequest.requestId === "string"
              ? rawRequest.requestId
              : "invalid",
          ok: false,
          error: {
            code:
              error instanceof InvalidCompanionRequestError
                ? error.code
                : "invalid_request",
            message: errorMessage(error),
          },
        });
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
        sendResponse(socket, {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result,
        });
      } catch (error) {
        logger.event("error", "server", "response_error", {
          requestId: request.requestId,
          method: request.method,
          message: errorMessage(error),
        });
        sendResponse(socket, {
          type: "response",
          requestId: request.requestId,
          ok: false,
          error: {
            code:
              error instanceof InvalidCompanionRequestError
                ? error.code
                : "request_failed",
            message: errorMessage(error),
          },
        });
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
