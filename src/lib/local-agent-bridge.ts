import type {
  LocalCompanionMethod,
  LocalCompanionRequestEnvelope,
  LocalCompanionResponseEnvelope,
} from "./local-agent-protocol.ts";

export const DEFAULT_LOCAL_COMPANION_URL = "ws://127.0.0.1:4315/ws";
export const DEFAULT_LOCAL_COMPANION_TIMEOUT_MS = 8_000;

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const SocketCtor = globalThis.WebSocket;
  if (typeof SocketCtor !== "function") {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new SocketCtor(url) as unknown as WebSocketLike;
}

function defaultRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (typeof randomUUID === "function") {
    return randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeIncomingMessageData(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof Blob === "function" && data instanceof Blob) {
    throw new Error("Blob payloads must be normalized asynchronously");
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  throw new Error("Unsupported local companion message payload");
}

async function normalizeIncomingMessageDataAsync(data: unknown): Promise<string> {
  if (typeof Blob === "function" && data instanceof Blob) {
    return data.text();
  }
  return normalizeIncomingMessageData(data);
}

export function createLocalCompanionRequestEnvelope<TParams>(
  method: LocalCompanionMethod,
  params: TParams,
  requestId = defaultRequestId()
): LocalCompanionRequestEnvelope<TParams> {
  return {
    type: "request",
    requestId,
    method,
    params,
  };
}

export async function requestLocalCompanion<TResult, TParams = unknown>(
  method: LocalCompanionMethod,
  params: TParams,
  options?: {
    url?: string;
    timeoutMs?: number;
    webSocketFactory?: WebSocketFactory;
    requestId?: string;
  }
): Promise<TResult> {
  const requestId = options?.requestId ?? defaultRequestId();
  const payload = JSON.stringify(
    createLocalCompanionRequestEnvelope(method, params, requestId)
  );
  const url = options?.url ?? DEFAULT_LOCAL_COMPANION_URL;
  const timeoutMs =
    typeof options?.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_LOCAL_COMPANION_TIMEOUT_MS;
  const createSocket = options?.webSocketFactory ?? defaultWebSocketFactory;

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    const socket = createSocket(url);
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close(4000, "timeout");
      } catch {
        // ignore close failures during timeout cleanup
      }
      reject(new Error("Timed out waiting for the local companion"));
    }, timeoutMs);

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    };

    socket.onopen = () => {
      try {
        socket.send(payload);
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to send request to the local companion")
        );
      }
    };

    socket.onmessage = async (event) => {
      if (settled) return;

      let parsed: LocalCompanionResponseEnvelope<TResult>;
      try {
        parsed = JSON.parse(
          await normalizeIncomingMessageDataAsync(event.data)
        ) as LocalCompanionResponseEnvelope<TResult>;
      } catch (error) {
        settled = true;
        cleanup();
        try {
          socket.close(1003, "invalid-json");
        } catch {
          // ignore close failures during parse cleanup
        }
        reject(
          error instanceof Error
            ? error
            : new Error("Received an invalid response from the local companion")
        );
        return;
      }

      if (
        parsed?.type !== "response" ||
        parsed.requestId !== requestId
      ) {
        return;
      }

      settled = true;
      cleanup();
      try {
        socket.close(1000, "done");
      } catch {
        // ignore close failures after successful response
      }

      if (!parsed.ok) {
        reject(
          new Error(
            parsed.error?.message || "Local companion request failed"
          )
        );
        return;
      }

      resolve((parsed.result ?? {}) as TResult);
    };

    socket.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "Could not connect to the local companion. Start it on your device and try again."
        )
      );
    };

    socket.onclose = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason =
        typeof event?.reason === "string" && event.reason.trim()
          ? event.reason.trim()
          : "connection closed";
      reject(new Error(`Local companion connection closed: ${reason}`));
    };
  });
}
