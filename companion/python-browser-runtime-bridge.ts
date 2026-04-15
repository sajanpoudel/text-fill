import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  LocalCompanionCandidateScanItem,
  LocalCompanionFieldTarget,
  LocalCompanionProviderConfig,
  LocalCompanionStructuredExtraction,
} from "../src/lib/local-agent-protocol.ts";

type ConsoleLike = Pick<typeof console, "log" | "warn" | "error">;

type BridgeMethod =
  | "health"
  | "navigate_to_url"
  | "insert_draft"
  | "execute_linkedin_connect_batch"
  | "execute_agent_task"
  | "shutdown";

type BridgeRequest = {
  id: string;
  method: BridgeMethod;
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

export interface PythonBrowserRuntimeBridgeProcessOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger?: ConsoleLike;
}

export interface PythonBrowserRuntimeConnection {
  health(): Promise<{ connected: boolean; error?: string }>;
  navigateToUrl(args: {
    targetUrl: string;
    currentPageUrl?: string;
    targetLabel?: string;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }>;
  insertDraft(args: {
    pageUrl: string;
    fieldTarget: LocalCompanionFieldTarget;
    generatedText: string;
    verifyText: string;
    targetName?: string;
    providerConfig: LocalCompanionProviderConfig;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }>;
  executeLinkedInConnectBatch(args: {
    items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
    dailyLimit: number;
    providerConfig: LocalCompanionProviderConfig;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }>;
  executeAgentTask(args: {
    providerConfig: LocalCompanionProviderConfig;
    goal: string;
    pageUrl?: string;
    platformHint?: string;
    pageContext?: string;
    fieldTarget?: LocalCompanionFieldTarget;
    structured?: LocalCompanionStructuredExtraction | null;
    scannedCandidates?: LocalCompanionCandidateScanItem[];
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }>;
  close(): Promise<void>;
}

function createRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return typeof randomUUID === "function"
    ? randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildPythonBrowserRuntimeProcessOptions(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Required<
  Pick<PythonBrowserRuntimeBridgeProcessOptions, "command" | "args" | "cwd" | "env">
> {
  const scriptPath =
    env.MCP_AGENT_PYTHON_RUNTIME_SCRIPT?.trim() ||
    join(cwd, "companion", "python_browser_runtime.py");

  return {
    command: env.MCP_AGENT_PYTHON_RUNTIME_COMMAND?.trim() || "python3",
    args: env.MCP_AGENT_PYTHON_RUNTIME_ARGS?.trim()
      ? env.MCP_AGENT_PYTHON_RUNTIME_ARGS.trim().split(/\s+/u)
      : [
          "-m",
          "uv",
          "run",
          "--with",
          "mcp-agent",
          "--with",
          "openai",
          "--with",
          "anthropic",
          "--with",
          "google-genai",
          "python",
          scriptPath,
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

export async function createPythonBrowserRuntimeConnection(
  options: PythonBrowserRuntimeBridgeProcessOptions = {}
): Promise<PythonBrowserRuntimeConnection> {
  const logger = options.logger ?? console;
  const defaults = buildPythonBrowserRuntimeProcessOptions(
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
      } catch {
        logger.warn(`[python-browser-runtime] ignored non-JSON stdout: ${line}`);
        continue;
      }

      const request = pending.get(response.id);
      if (!request) {
        continue;
      }
      pending.delete(response.id);
      if (!response.ok) {
        request.reject(
          new Error(response.error || "python browser runtime request failed")
        );
        continue;
      }
      request.resolve(response.result);
    }
  });

  child.stderr.on("data", (chunk: string) => {
    const filteredChunk = chunk
      .split("\n")
      .filter(
        (line) =>
          !line.includes("No handler registered for issue code PerformanceIssue")
      )
      .join("\n");

    if (filteredChunk.trim()) {
      stderrBuffer += `${filteredChunk}\n`;
      logger.log(`[python-browser-runtime] ${filteredChunk.trim()}`);
    }
  });

  child.on("error", (error) => {
    rejectPending(
      `Failed to start the python browser runtime: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  child.on("exit", (code, signal) => {
    closed = true;
    const trailingStderr = stderrBuffer.trim();
    const suffix = trailingStderr ? ` ${trailingStderr}` : "";
    rejectPending(
      `python browser runtime exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).${suffix}`
    );
  });

  const request = async <TResult>(
    method: BridgeMethod,
    args?: Record<string, unknown>
  ): Promise<TResult> => {
    if (closed) {
      throw new Error("python browser runtime is not running");
    }
    const id = createRequestId();
    const payload: BridgeRequest = { id, method, ...(args ? { args } : {}) };
    return new Promise<TResult>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });

      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }
        pending.delete(id);
        reject(
          new Error(
            `Failed to send request to the python browser runtime: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      });
    });
  };

  await request<{ connected: boolean }>("health");

  return {
    async health() {
      return request<{ connected: boolean; error?: string }>("health");
    },
    async navigateToUrl(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }>("navigate_to_url", args as unknown as Record<string, unknown>);
    },
    async insertDraft(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }>("insert_draft", args as unknown as Record<string, unknown>);
    },
    async executeLinkedInConnectBatch(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }>("execute_linkedin_connect_batch", args as unknown as Record<string, unknown>);
    },
    async executeAgentTask(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }>("execute_agent_task", args as unknown as Record<string, unknown>);
    },
    async close() {
      if (closed) {
        return;
      }
      try {
        await Promise.race([
          request("shutdown"),
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
