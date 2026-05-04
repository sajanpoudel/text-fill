import { describe, expect, test } from "vitest";
import {
  createLocalCompanionRequestEnvelope,
  requestLocalCompanion,
} from "../../../src/lib/local-agent-bridge.ts";

class MockWebSocket {
  static readonly OPEN = 1;

  readyState = MockWebSocket.OPEN;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  sentPayloads: string[] = [];

  constructor(
    private readonly responder:
      | ((socket: MockWebSocket, payload: string) => void)
      | "error"
  ) {
    queueMicrotask(() => {
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sentPayloads.push(data);
    if (this.responder === "error") {
      queueMicrotask(() => {
        this.onerror?.({});
      });
      return;
    }
    this.responder(this, data);
  }

  close(code?: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }
}

describe("local agent bridge", () => {
  test("builds request envelopes with the expected shape", () => {
    expect(
      createLocalCompanionRequestEnvelope(
        "get_panel_state",
        { userScope: "scope-1", limit: 5 },
        "req-1"
      )
    ).toEqual({
      type: "request",
      requestId: "req-1",
      method: "get_panel_state",
      params: {
        userScope: "scope-1",
        limit: 5,
      },
    });
  });

  test("sends a request and resolves a matching response", async () => {
    const result = await requestLocalCompanion<{ ok: boolean }>(
      "health",
      {},
      {
        requestId: "req-2",
        timeoutMs: 100,
        webSocketFactory: () =>
          new MockWebSocket((socket, payload) => {
            const parsed = JSON.parse(payload) as { requestId: string };
            queueMicrotask(() => {
              socket.onmessage?.({
                data: JSON.stringify({
                  type: "response",
                  requestId: parsed.requestId,
                  ok: true,
                  result: { ok: true },
                }),
              });
            });
          }),
      }
    );

    expect(result).toEqual({ ok: true });
  });

  test("accepts blob websocket payloads from the companion", async () => {
    const result = await requestLocalCompanion<{ ok: boolean }>(
      "health",
      {},
      {
        requestId: "req-blob",
        timeoutMs: 100,
        webSocketFactory: () =>
          new MockWebSocket((socket, payload) => {
            const parsed = JSON.parse(payload) as { requestId: string };
            queueMicrotask(() => {
              socket.onmessage?.({
                data: new Blob([
                  JSON.stringify({
                    type: "response",
                    requestId: parsed.requestId,
                    ok: true,
                    result: { ok: true },
                  }),
                ]),
              });
            });
          }),
      }
    );

    expect(result).toEqual({ ok: true });
  });

  test("rejects protocol-level errors from the companion", async () => {
    await expect(
      requestLocalCompanion("health", {}, {
        requestId: "req-3",
        timeoutMs: 100,
        webSocketFactory: () =>
          new MockWebSocket((socket, payload) => {
            const parsed = JSON.parse(payload) as { requestId: string };
            queueMicrotask(() => {
              socket.onmessage?.({
                data: JSON.stringify({
                  type: "response",
                  requestId: parsed.requestId,
                  ok: false,
                  error: { message: "Companion unavailable" },
                }),
              });
            });
          }),
      })
    ).rejects.toThrow("Companion unavailable");
  });

  test("rejects connection failures with a clear message", async () => {
    await expect(
      requestLocalCompanion("health", {}, {
        requestId: "req-4",
        timeoutMs: 100,
        webSocketFactory: () => new MockWebSocket("error"),
      })
    ).rejects.toThrow("Could not connect to the local companion");
  });
});
