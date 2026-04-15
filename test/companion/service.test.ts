import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { LocalAgentCompanionService } from "../../companion/service.ts";
import type { LocalCompanionFieldTarget } from "../../src/lib/local-agent-protocol.ts";
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
  }> = [];
  batchCalls: Array<{
    items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
    dailyLimit: number;
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

  async dispose() {
    return;
  }
}

async function createTestService(
  llmResponse:
    | string
    | ((args: Parameters<LocalAgentCompanionService["startRun"]>[0]) => string | Promise<string>),
  runtime = new FakeRuntime()
) {
  const dir = await mkdtemp(join(tmpdir(), "text-fill-companion-"));
  tempDirs.push(dir);
  const store = new CompanionStateStore(join(dir, "state.json"));
  const llmCalls: Array<{
    provider: string;
    model: string;
    apiKey: string;
    system: string;
    user: string;
  }> = [];
  const llmCaller = async (args: {
    provider: string;
    model: string;
    apiKey: string;
    system: string;
    user: string;
  }) => {
    llmCalls.push(args);
    if (typeof llmResponse === "function") {
      return llmResponse(args as never);
    }
    return llmResponse;
  };
  return {
    service: new LocalAgentCompanionService(
      store,
      llmCaller as never,
      runtime as never,
      createNoopCompanionLogger()
    ),
    runtime,
    llmCalls,
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
    const { service } = await createTestService("Hi there", runtime);

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

  test("creates an approval-gated conversation draft flow and completes it through the runtime", async () => {
    const { service, runtime, llmCalls } = await createTestService(
      "Hi Taylor,\n\nThanks for following up here."
    );

    const started = await service.startRun({
      userScope: "user:1",
      goal: "Reply to this recruiter",
      platformHint: "gmail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
      pageContext:
        "Audience: Taylor Recruiter\nThread context:\nFollowing up on backend hiring.",
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
    expect(pending.runs[0]?.status).toBe("awaiting_approval");
    expect(pending.approvals).toHaveLength(1);
    expect(pending.approvals[0]?.approvalKind).toBe("draft_insert");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5-nano",
      apiKey: "test-key",
    });
    expect(runtime.draftCalls).toHaveLength(0);

    const resolved = await service.resolveApproval({
      userScope: "user:1",
      approvalId: pending.approvals[0]!._id,
      decision: "approved",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.status).toBe("executing");

    const completed = await waitForRunStatus(service, "user:1", "completed");
    expect(runtime.draftCalls).toHaveLength(1);
    expect(runtime.draftCalls[0]?.pageUrl).toContain("mail.google.com");
    expect(runtime.draftCalls[0]?.fieldTarget.selector).toBe("#composer");
    expect(completed.approvals).toHaveLength(0);
    expect(completed.runs[0]?.status).toBe("completed");
    expect(completed.runs[0]?.latestSummary).toContain("Taylor Recruiter");
  });

  test("falls back to a partial approved LinkedIn queue when more search pages exist", async () => {
    const { service, runtime, llmCalls } = await createTestService(
      JSON.stringify({
        drafts: [
          {
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            generatedText:
              "Hi Carolyn, your work recruiting for platform teams stood out to me. I’d love to connect and stay in touch.",
          },
        ],
      })
    );

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
    expect(state.runs[0]?.status).toBe("awaiting_approval");
    expect(state.approvals).toHaveLength(1);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5-nano",
      apiKey: "test-key",
    });
    expect(runtime.batchCalls).toHaveLength(0);

    const approvalPayload = state.approvals[0]?.payload as
      | { items?: Array<{ generatedText?: string }> }
      | undefined;
    expect(approvalPayload?.items).toHaveLength(2);
    expect(approvalPayload?.items?.[0]?.generatedText).toContain("platform");

    const resolved = await service.resolveApproval({
      userScope: "user:2",
      approvalId: state.approvals[0]!._id,
      decision: "approved",
    });
    expect(resolved.status).toBe("executing");

    const completed = await waitForRunStatus(service, "user:2", "completed");

    expect(runtime.batchCalls).toHaveLength(1);
    expect(runtime.batchCalls[0]?.items).toHaveLength(2);
    expect(completed.runs[0]?.status).toBe("completed");
  });

  test("executes a safe LinkedIn jobs search navigation without creating an approval gate", async () => {
    const { service, runtime, llmCalls } = await createTestService("unused");

    await service.startRun({
      userScope: "user:jobs",
      goal: "Search software engineering jobs in LinkedIn",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/feed/",
    });

    const completed = await waitForRunStatus(service, "user:jobs", "completed");

    expect(llmCalls).toHaveLength(0);
    expect(completed.approvals).toHaveLength(0);
    expect(runtime.navigateCalls).toHaveLength(1);
    expect(runtime.navigateCalls[0]).toMatchObject({
      currentPageUrl: "https://www.linkedin.com/feed/",
      targetLabel: "software engineering jobs",
    });
    expect(runtime.navigateCalls[0]?.targetUrl).toContain(
      "https://www.linkedin.com/jobs/search/?keywords=software%20engineering"
    );
    expect(completed.runs[0]?.latestSummary).toContain(
      "Opened LinkedIn search results for software engineering jobs."
    );
  });

  test("marks the run cancelled when the user rejects the approval gate", async () => {
    const { service } = await createTestService("Hi there");

    await service.startRun({
      userScope: "user:3",
      goal: "Reply to this message",
      platformHint: "slack",
      pageUrl: "https://app.slack.com/client/T1/C1",
      pageContext: "Audience: Priya\nThread context:\nNeed a quick follow-up.",
      fieldTarget: {
        selector: "[data-qa='message_input']",
        platform: "slack",
        charLimit: 300,
      },
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const state = await service.getPanelState({
      userScope: "user:3",
      limit: 5,
    });
    const approvalId = state.approvals[0]!._id;

    const resolved = await service.resolveApproval({
      userScope: "user:3",
      approvalId,
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
    const { service } = await createTestService("Hi there", new FakeRuntime({
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
