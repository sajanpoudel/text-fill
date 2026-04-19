import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

type ConsoleLike = Pick<typeof console, "log" | "warn" | "error">;

type BridgeRequest = {
  id: string;
  method: "call_tool" | "health" | "shutdown";
  toolName?: string;
  args?: Record<string, unknown>;
};

type BridgeResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type PendingBridgeRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ChromeMcpToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface ChromeDevtoolsMcpConnection {
  callTool(
    name: string,
    args?: Record<string, unknown>
  ): Promise<ChromeMcpToolResult>;
  close(): Promise<void>;
}

export interface McpAgentBridgeProcessOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger?: ConsoleLike;
}

function createRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return typeof randomUUID === "function"
    ? randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseProcessArgs(
  env: NodeJS.ProcessEnv,
  jsonKey: string,
  rawKey: string
): string[] | null {
  const rawJson = env[jsonKey]?.trim();
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error(`${jsonKey} must be a JSON string array.`);
    }
    return parsed;
  }

  const rawArgs = env[rawKey]?.trim();
  return rawArgs ? rawArgs.split(/\s+/u) : null;
}

export function buildMcpAgentBridgeProcessOptions(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Required<Pick<McpAgentBridgeProcessOptions, "command" | "args" | "cwd" | "env">> {
  const bridgePath =
    env.MCP_AGENT_BRIDGE_SCRIPT?.trim() ||
    join(cwd, "companion", "mcp_agent_bridge.py");

  return {
    command: env.MCP_AGENT_BRIDGE_COMMAND?.trim() || "python3",
    args:
      parseProcessArgs(env, "MCP_AGENT_BRIDGE_ARGS_JSON", "MCP_AGENT_BRIDGE_ARGS") ?? [
          "-m",
          "uv",
          "run",
          "--with",
          "mcp-agent",
          "--with",
          "temporalio",
          "python",
          bridgePath,
        ],
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(
          ([, value]) => typeof value === "string"
        ) as Array<[string, string]>
      ),
      PYTHONUNBUFFERED: "1",
    },
  };
}

export async function createMcpAgentBridgeConnection(
  options: McpAgentBridgeProcessOptions = {}
): Promise<ChromeDevtoolsMcpConnection> {
  const logger = options.logger ?? console;
  const defaults = buildMcpAgentBridgeProcessOptions(
    process.env,
    options.cwd ?? process.cwd()
  );
  const spawnOptions = {
    ...defaults,
    ...options,
    env: {
      ...defaults.env,
      ...(options.env ?? {}),
    },
  };
  const child = spawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    stdio: "pipe",
  });

  const pending = new Map<string, PendingBridgeRequest>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      request.reject(new Error(message));
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let response: BridgeResponse;
      try {
        response = JSON.parse(line) as BridgeResponse;
      } catch (error) {
        logger.warn(`[mcp-agent] ignored non-JSON stdout: ${line}`);
        continue;
      }

      const request = pending.get(response.id);
      if (!request) {
        continue;
      }
      pending.delete(response.id);
      if (!response.ok) {
        request.reject(
          new Error(response.error || "mcp-agent bridge request failed")
        );
        continue;
      }
      request.resolve(response.result);
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    const text = chunk.trim();
    if (text) {
      logger.log(`[mcp-agent] ${text}`);
    }
  });

  child.on("error", (error) => {
    rejectPending(
      `Failed to start the mcp-agent bridge: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  child.on("exit", (code, signal) => {
    closed = true;
    const trailingStderr = stderrBuffer.trim();
    const suffix = trailingStderr ? ` ${trailingStderr}` : "";
    rejectPending(
      `mcp-agent bridge exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).${suffix}`
    );
  });

  const request = async <TResult>(payload: Omit<BridgeRequest, "id">): Promise<TResult> => {
    if (closed) {
      throw new Error("mcp-agent bridge is not running");
    }
    const id = createRequestId();
    const envelope: BridgeRequest = {
      id,
      ...payload,
    };

    return new Promise<TResult>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      child.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error) {
          return;
        }
        pending.delete(id);
        reject(
          new Error(
            `Failed to send request to the mcp-agent bridge: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      });
    });
  };

  await request<unknown>({
    method: "health",
  });

  return {
    async callTool(name, args) {
      return request<ChromeMcpToolResult>({
        method: "call_tool",
        toolName: name,
        args: args ?? {},
      });
    },
    async close() {
      if (closed) {
        return;
      }
      try {
        await Promise.race([
          request<unknown>({
            method: "shutdown",
          }),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } catch {
        // Ignore and force shutdown below.
      }
      child.stdin.end();
      if (!child.killed) {
        child.kill();
      }
      closed = true;
    },
  };
}

export type { ConsoleLike };
