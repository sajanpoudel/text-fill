import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { LocalAgentCompanionService } from "../../companion/service.ts";
import type {
  LocalCompanionFieldTarget,
  LocalCompanionProviderConfig,
} from "../../src/lib/local-agent-protocol.ts";
import { CompanionStateStore } from "../../companion/state-store.ts";
import { createNoopCompanionLogger } from "../../companion/live-logger.ts";

const tempDirs: string[] = [];

class FakeRuntime {
  navigateCalls: Array<{
    targetUrl: string;
    currentPageUrl?: string;
    targetLabel?: string;
  }> = [];
  draftCalls: Array<{
    pageUrl: string;
    fieldTarget: LocalCompanionFieldTarget;
    generatedText: string;
    verifyText: string;
    targetName?: string;
    providerConfig: LocalCompanionProviderConfig;
  }> = [];
  batchCalls: Array<{
    items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
    dailyLimit: number;
    providerConfig: LocalCompanionProviderConfig;
  }> = [];
  agentTaskCalls: Array<{
    providerConfig: LocalCompanionProviderConfig;
    goal: string;
    pageUrl?: string;
    platformHint?: string;
    pageContext?: string;
    userContext?: string;
    systemPrompt?: string;
    fieldTarget?: LocalCompanionFieldTarget;
    structured?: unknown;
    scannedCandidates?: unknown[];
  }> = [];

  constructor(
    private readonly options: {
      health?:
        | { connected: boolean; error?: string }
        | (() => Promise<{ connected: boolean; error?: string }>);
      navigateToUrl?: (args: FakeRuntime["navigateCalls"][number]) => Promise<{
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
      insertDraft?: (args: FakeRuntime["draftCalls"][number]) => Promise<{
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
      executeLinkedInConnectBatch?: (
        args: FakeRuntime["batchCalls"][number]
      ) => Promise<{
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
      executeAgentTask?: (
        args: FakeRuntime["agentTaskCalls"][number]
      ) => Promise<{
        summary: string;
        metadata?: Record<string, unknown>;
      }>;
    } = {}
  ) {}

  async checkAvailability() {
    if (typeof this.options.health === "function") {
      return this.options.health();
    }
    return this.options.health ?? { connected: true };
  }

  async navigateToUrl(args: FakeRuntime["navigateCalls"][number]) {
    this.navigateCalls.push(args);
    if (this.options.navigateToUrl) {
      return this.options.navigateToUrl(args);
    }
    return {
      summary: args.targetLabel
        ? `Opened LinkedIn search results for ${args.targetLabel}.`
        : "Opened the requested page.",
      metadata: {
        kind: "navigate_to_url",
      },
    };
  }

  async insertDraft(args: FakeRuntime["draftCalls"][number]) {
    this.draftCalls.push(args);
    if (this.options.insertDraft) {
      return this.options.insertDraft(args);
    }
    return {
      summary: args.targetName
        ? `Inserted the approved draft for ${args.targetName}.`
        : "Inserted the approved draft into the active field.",
      metadata: {
        kind: "insert_draft",
      },
    };
  }

  async executeLinkedInConnectBatch(args: FakeRuntime["batchCalls"][number]) {
    this.batchCalls.push(args);
    if (this.options.executeLinkedInConnectBatch) {
      return this.options.executeLinkedInConnectBatch(args);
    }
    return {
      summary: `LinkedIn connect batch finished for ${args.items.length} targets.`,
      metadata: {
        kind: "execute_task_batch",
        itemCount: args.items.length,
      },
    };
  }

  async executeAgentTask(args: FakeRuntime["agentTaskCalls"][number]) {
    this.agentTaskCalls.push(args);
    if (this.options.executeAgentTask) {
      return this.options.executeAgentTask(args);
    }
    return {
      summary: `Agent completed: ${args.goal}`,
      metadata: {
        kind: "execute_agent_task",
      },
    };
  }

  async dispose() {
    return;
  }
}

async function createTestService(
  runtime = new FakeRuntime()
) {
  const dir = await mkdtemp(join(tmpdir(), "text-fill-companion-"));
  tempDirs.push(dir);
  const store = new CompanionStateStore(join(dir, "state.json"));
  return {
    service: new LocalAgentCompanionService(
      store,
      runtime as never,
      createNoopCompanionLogger()
    ),
    store,
    runtime,
  };
}

async function waitForRunStatus(
  service: LocalAgentCompanionService,
  userScope: string,
  expectedStatus: string
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await service.getPanelState({
      userScope,
      limit: 5,
    });
    if (state.runs[0]?.status === expectedStatus) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return service.getPanelState({
    userScope,
    limit: 5,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("LocalAgentCompanionService", () => {
  test("returns panel state immediately while runtime health warms in the background", async () => {
    const runtime = new FakeRuntime({
      health: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { connected: true };
      },
    });
    const { service } = await createTestService(runtime);

    const startedAt = Date.now();
    const state = await service.getPanelState({
      userScope: "user:warmup",
      limit: 5,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(100);
    expect(state.runtimeConnected).toBe(false);
    expect(state.runtimeError).toBe("Starting local browser runtime.");

    await new Promise((resolve) => setTimeout(resolve, 120));

    const warmed = await service.getPanelState({
      userScope: "user:warmup",
      limit: 5,
    });
    expect(warmed.runtimeConnected).toBe(true);
  });

  test("routes compose tasks directly through the python mcp-agent runtime", async () => {
    const { service, runtime } = await createTestService();

    const started = await service.startRun({
      userScope: "user:1",
      goal: "Reply to this recruiter",
      platformHint: "gmail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
      pageContext:
        "Audience: Taylor Recruiter\nThread context:\nFollowing up on backend hiring.",
      userContext: "I build backend and AI agent tooling for recruiting workflows.",
      systemPrompt: "Be direct and avoid fluff.",
      fieldTarget: {
        selector: "#composer",
        platform: "gmail",
        fieldType: "[EMAIL_BODY]",
        charLimit: 1200,
      },
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    expect(started.runId).toBeTruthy();
    expect(started.runtimeId).toBe(started.runId);

    const pending = await service.getPanelState({
      userScope: "user:1",
      limit: 5,
    });
    expect(["executing", "completed"]).toContain(pending.runs[0]?.status);
    expect(pending.approvals).toHaveLength(0);
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]).toMatchObject({
      goal: "Reply to this recruiter",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
      platformHint: "gmail",
      userContext: "I build backend and AI agent tooling for recruiting workflows.",
      systemPrompt: "Be direct and avoid fluff.",
    });
    expect(runtime.draftCalls).toHaveLength(0);

    const completed = await waitForRunStatus(service, "user:1", "completed");
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(completed.approvals).toHaveLength(0);
    expect(completed.runs[0]?.status).toBe("completed");
    expect(completed.runs[0]?.latestSummary).toContain("Agent completed");
  });

  test("routes LinkedIn search tasks directly through the python mcp-agent runtime", async () => {
    const { service, runtime } = await createTestService();

    await service.startRun({
      userScope: "user:2",
      goal: "Find 5 software engineering recruiters and send connection requests",
      platformHint: "linkedin",
      pageUrl:
        "https://www.linkedin.com/search/results/people/?keywords=software%20recruiter",
      scannedCandidates: [
        {
          targetName: "Carolyn Wilmes Orr",
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          headline: "Principal Engineering Recruiter",
        },
        {
          targetName: "Taylor Recruiter",
          targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          headline: "Senior Software Recruiter",
        },
      ],
      nextPageUrl:
        "https://www.linkedin.com/search/results/people/?page=2&keywords=software%20recruiter",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const state = await service.getPanelState({
      userScope: "user:2",
      limit: 5,
    });
    expect(["executing", "completed"]).toContain(state.runs[0]?.status);
    expect(state.approvals).toHaveLength(0);
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.batchCalls).toHaveLength(0);

    const completed = await waitForRunStatus(service, "user:2", "completed");

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.scannedCandidates).toHaveLength(2);
    expect(completed.runs[0]?.status).toBe("completed");
  });

  test("routes LinkedIn jobs search through the python mcp-agent runtime", async () => {
    const { service, runtime } = await createTestService();

    await service.startRun({
      userScope: "user:jobs",
      goal: "Search software engineering jobs in LinkedIn",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/feed/",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(service, "user:jobs", "completed");

    expect(completed.approvals).toHaveLength(0);
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]).toMatchObject({
      goal: "Search software engineering jobs in LinkedIn",
      pageUrl: "https://www.linkedin.com/feed/",
      platformHint: "linkedin",
    });
    expect(completed.runs[0]?.latestSummary).toContain("Agent completed");
  });

  test("uses the python mcp-agent browser runtime for generic goals when no deterministic action applies", async () => {
    const { service, runtime } = await createTestService();

    await service.startRun({
      userScope: "user:generic",
      goal: "Open the current LinkedIn company page and inspect the hiring section",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/company/example/",
      pageContext: "Company page with hiring and people tabs visible.",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(service, "user:generic", "completed");

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]).toMatchObject({
      goal: "Open the current LinkedIn company page and inspect the hiring section",
      pageUrl: "https://www.linkedin.com/company/example/",
      platformHint: "linkedin",
    });
    expect(completed.runs[0]?.latestSummary).toContain("Agent completed");
  });

  test("marks the run cancelled when the user rejects the approval gate", async () => {
    const { service, store } = await createTestService();
    const run = await store.createRun({
      userScope: "user:3",
      goal: "Legacy run",
      pageUrl: "https://app.slack.com/client/T1/C1",
    });
    const approval = await store.createApproval({
      userScope: "user:3",
      runId: run._id,
      approvalKind: "draft_insert",
      title: "Legacy approval",
      payload: {
        actionType: "insert_draft",
        generatedText: "Hi Priya",
        fieldTarget: {
          selector: "[data-qa='message_input']",
        },
      },
    });

    const resolved = await service.resolveApproval({
      userScope: "user:3",
      approvalId: approval._id,
      decision: "rejected",
      decisionNote: "Not the right tone.",
    });
    expect(resolved.status).toBe("rejected");

    const finalState = await service.getPanelState({
      userScope: "user:3",
      limit: 5,
    });
    expect(finalState.approvals).toHaveLength(0);
    expect(finalState.runs[0]?.status).toBe("cancelled");
    expect(finalState.runs[0]?.latestSummary).toBe("Not the right tone.");
  });

  test("surfaces MCP runtime health in panel state", async () => {
    const { service } = await createTestService(new FakeRuntime({
      health: {
        connected: false,
        error: "Chrome DevTools MCP could not connect",
      },
    }));

    const state = await service.getPanelState({
      userScope: "user:health",
      limit: 5,
    });

    expect(state.runtimeConnected).toBe(false);
    expect(state.runtimeError).toContain("could not connect");
  });
});
