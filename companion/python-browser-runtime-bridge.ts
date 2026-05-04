import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  LocalCompanionBrowserWorkItem,
  LocalCompanionCandidateScanItem,
  LocalCompanionFieldTarget,
  LocalCompanionProviderConfig,
  ResumeFileData,
  LocalCompanionStructuredExtraction,
} from "../src/lib/local-agent-protocol.ts";

type ConsoleLike = Pick<typeof console, "log" | "warn" | "error">;

type BridgeMethod =
  | "health"
  | "derive_browser_work_items"
  | "start_generic_browser_task_workflow"
  | "start_generic_browser_queue_workflow"
  | "start_linkedin_connect_batch_workflow"
  | "get_workflow_status"
  | "resume_workflow"
  | "cancel_workflow"
  | "navigate_to_url"
  | "insert_draft"
  | "execute_linkedin_connect_batch"
  | "execute_agent_task"
  | "shutdown";

type BridgeArgs = Record<string, unknown>;

type BridgeRequest = {
  id: string;
  method: BridgeMethod;
  args?: BridgeArgs;
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

type AgentTaskArgs = {
  providerConfig: LocalCompanionProviderConfig;
  goal: string;
  pageUrl?: string;
  platformHint?: string;
  pageContext?: string;
  resumeContext?: string;
  siteExperienceContext?: string;
  userContext?: string;
  systemPrompt?: string;
  fieldTarget?: LocalCompanionFieldTarget;
  structured?: LocalCompanionStructuredExtraction | null;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
  workItems?: LocalCompanionBrowserWorkItem[];
};

type ManagedWorkflowArgs = AgentTaskArgs & {
  resumeFile?: ResumeFileData | null;
};

type LinkedInConnectBatchArgs = {
  items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
  dailyLimit: number;
  providerConfig: LocalCompanionProviderConfig;
};

type WorkflowHandleArgs = {
  workflowId?: string;
  runId?: string;
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
  deriveBrowserWorkItems(args: AgentTaskArgs): Promise<{
    mode: "single" | "queue";
    summary: string;
    workItems: LocalCompanionBrowserWorkItem[];
  }>;
  startGenericBrowserTaskWorkflow(args: ManagedWorkflowArgs): Promise<{
    workflowId: string;
    runId?: string;
  }>;
  startGenericBrowserQueueWorkflow(args: ManagedWorkflowArgs & {
    workItems: LocalCompanionBrowserWorkItem[];
  }): Promise<{
    workflowId: string;
    runId?: string;
  }>;
  startLinkedInConnectBatchWorkflow(args: LinkedInConnectBatchArgs): Promise<{
    workflowId: string;
    runId?: string;
  }>;
  getWorkflowStatus(args: WorkflowHandleArgs): Promise<Record<string, unknown> | null>;
  resumeWorkflow(args: WorkflowHandleArgs & {
    signalName?: string;
    payload?: unknown;
  }): Promise<boolean>;
  cancelWorkflow(args: WorkflowHandleArgs): Promise<boolean>;
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
  executeLinkedInConnectBatch(args: LinkedInConnectBatchArgs): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }>;
  executeAgentTask(args: ManagedWorkflowArgs): Promise<{
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
    args:
      parseProcessArgs(
        env,
        "MCP_AGENT_PYTHON_RUNTIME_ARGS_JSON",
        "MCP_AGENT_PYTHON_RUNTIME_ARGS"
      ) ?? [
          "-m",
          "uv",
          "run",
          "--with",
          "mcp-agent",
          "--with",
          "temporalio",
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
  let shuttingDown = false;

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
    if (shuttingDown) {
      closed = true;
      pending.clear();
      return;
    }
    rejectPending(
      `Failed to start the python browser runtime: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  child.on("exit", (code, signal) => {
    closed = true;
    if (shuttingDown) {
      pending.clear();
      return;
    }
    const trailingStderr = stderrBuffer.trim();
    const suffix = trailingStderr ? ` ${trailingStderr}` : "";
    rejectPending(
      `python browser runtime exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).${suffix}`
    );
  });

  const request = async <TResult, TArgs extends BridgeArgs = BridgeArgs>(
    method: BridgeMethod,
    args?: TArgs
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
    async deriveBrowserWorkItems(args) {
      return request<{
        mode: "single" | "queue";
        summary: string;
        workItems: LocalCompanionBrowserWorkItem[];
      }, AgentTaskArgs>("derive_browser_work_items", args);
    },
    async startGenericBrowserTaskWorkflow(args) {
      return request<{
        workflowId: string;
        runId?: string;
      }, ManagedWorkflowArgs>("start_generic_browser_task_workflow", args);
    },
    async startGenericBrowserQueueWorkflow(args) {
      return request<{
        workflowId: string;
        runId?: string;
      }, ManagedWorkflowArgs & { workItems: LocalCompanionBrowserWorkItem[] }>(
        "start_generic_browser_queue_workflow",
        args
      );
    },
    async startLinkedInConnectBatchWorkflow(args) {
      return request<{
        workflowId: string;
        runId?: string;
      }, LinkedInConnectBatchArgs>("start_linkedin_connect_batch_workflow", args);
    },
    async getWorkflowStatus(args) {
      return request<Record<string, unknown> | null, WorkflowHandleArgs>(
        "get_workflow_status",
        args
      );
    },
    async resumeWorkflow(args) {
      return request<boolean, WorkflowHandleArgs & {
        signalName?: string;
        payload?: unknown;
      }>(
        "resume_workflow",
        args
      );
    },
    async cancelWorkflow(args) {
      return request<boolean, WorkflowHandleArgs>(
        "cancel_workflow",
        args
      );
    },
    async navigateToUrl(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }, {
        targetUrl: string;
        currentPageUrl?: string;
        targetLabel?: string;
      }>("navigate_to_url", args);
    },
    async insertDraft(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }, {
        pageUrl: string;
        fieldTarget: LocalCompanionFieldTarget;
        generatedText: string;
        verifyText: string;
        targetName?: string;
        providerConfig: LocalCompanionProviderConfig;
      }>("insert_draft", args);
    },
    async executeLinkedInConnectBatch(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }, LinkedInConnectBatchArgs>("execute_linkedin_connect_batch", args);
    },
    async executeAgentTask(args) {
      return request<{
        summary: string;
        metadata: Record<string, unknown>;
      }, ManagedWorkflowArgs>("execute_agent_task", args);
    },
    async close() {
      if (closed || shuttingDown) {
        return;
      }
      shuttingDown = true;
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
