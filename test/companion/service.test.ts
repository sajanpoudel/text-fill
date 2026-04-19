import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { LocalAgentCompanionService } from "../../companion/service.ts";
import type {
  LocalCompanionBrowserWorkItem,
  LocalCompanionFieldTarget,
  LocalCompanionProviderConfig,
  ResumeFileData,
} from "../../src/lib/local-agent-protocol.ts";
import { CompanionStateStore } from "../../companion/state-store.ts";
import { createNoopCompanionLogger } from "../../companion/live-logger.ts";

const tempDirs: string[] = [];
const services: LocalAgentCompanionService[] = [];

async function waitForApprovalStatus(
  store: CompanionStateStore,
  userScope: string,
  approvalId: string,
  status: string
) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const approval = await store.getApproval(userScope, approvalId);
    if (approval?.status === status) {
      return approval;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Approval ${approvalId} did not reach status ${status}`);
}

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
  workflowStartCalls: Array<{
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
    structured?: unknown;
    scannedCandidates?: unknown[];
    workItems?: LocalCompanionBrowserWorkItem[];
    resumeFile?: ResumeFileData | null;
  }> = [];
  workItemDiscoveryCalls: Array<{
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
    structured?: unknown;
    scannedCandidates?: unknown[];
    workItems?: LocalCompanionBrowserWorkItem[];
  }> = [];
  queueWorkflowStartCalls: Array<{
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
    structured?: unknown;
    scannedCandidates?: unknown[];
    workItems: LocalCompanionBrowserWorkItem[];
    resumeFile?: ResumeFileData | null;
  }> = [];
  batchWorkflowStartCalls: Array<{
    items: Array<{ targetUrl: string; targetName?: string; generatedText?: string }>;
    dailyLimit: number;
    providerConfig: LocalCompanionProviderConfig;
  }> = [];
  workflowStatusCalls: Array<{
    workflowId?: string;
    runId?: string;
  }> = [];
  workflowResumeCalls: Array<{
    workflowId?: string;
    runId?: string;
    signalName?: string;
    payload?: unknown;
  }> = [];
  workflowCancelCalls: Array<{
    workflowId?: string;
    runId?: string;
  }> = [];
  agentTaskCalls: Array<{
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
    structured?: unknown;
    scannedCandidates?: unknown[];
    resumeFile?: ResumeFileData | null;
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
      startAgentTaskWorkflow?: (
        args: FakeRuntime["workflowStartCalls"][number]
      ) => Promise<{
        workflowId: string;
        runId?: string;
      }>;
      deriveBrowserWorkItems?: (
        args: FakeRuntime["workItemDiscoveryCalls"][number]
      ) => Promise<{
        mode: "single" | "queue";
        summary: string;
        workItems: LocalCompanionBrowserWorkItem[];
      }>;
      startLinkedInConnectBatchWorkflow?: (
        args: FakeRuntime["batchWorkflowStartCalls"][number]
      ) => Promise<{
        workflowId: string;
        runId?: string;
      }>;
      startGenericBrowserQueueWorkflow?: (
        args: FakeRuntime["queueWorkflowStartCalls"][number]
      ) => Promise<{
        workflowId: string;
        runId?: string;
      }>;
      getAgentTaskWorkflowStatus?: (
        args: FakeRuntime["workflowStatusCalls"][number]
      ) => Promise<Record<string, unknown> | null>;
      resumeAgentTaskWorkflow?: (
        args: FakeRuntime["workflowResumeCalls"][number]
      ) => Promise<boolean>;
      cancelAgentTaskWorkflow?: (
        args: FakeRuntime["workflowCancelCalls"][number]
      ) => Promise<boolean>;
      supportsManagedTaskRetries?: boolean;
      supportsManagedTaskWorkflows?: boolean;
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

  supportsManagedTaskRetries() {
    return this.options.supportsManagedTaskRetries === true;
  }

  supportsManagedTaskWorkflows() {
    return this.options.supportsManagedTaskWorkflows === true;
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

  async startAgentTaskWorkflow(args: FakeRuntime["workflowStartCalls"][number]) {
    this.workflowStartCalls.push(args);
    if (this.options.startAgentTaskWorkflow) {
      return this.options.startAgentTaskWorkflow(args);
    }
    return {
      workflowId: "workflow-generic",
      runId: "workflow-run-generic",
    };
  }

  async deriveBrowserWorkItems(
    args: FakeRuntime["workItemDiscoveryCalls"][number]
  ) {
    this.workItemDiscoveryCalls.push(args);
    if (this.options.deriveBrowserWorkItems) {
      return this.options.deriveBrowserWorkItems(args);
    }
    return {
      mode: "single" as const,
      summary: "The page looks like a single browser task.",
      workItems: [],
    };
  }

  async startGenericBrowserQueueWorkflow(
    args: FakeRuntime["queueWorkflowStartCalls"][number]
  ) {
    this.queueWorkflowStartCalls.push(args);
    if (this.options.startGenericBrowserQueueWorkflow) {
      return this.options.startGenericBrowserQueueWorkflow(args);
    }
    return {
      workflowId: "workflow-queue",
      runId: "workflow-run-queue",
    };
  }

  async startLinkedInConnectBatchWorkflow(
    args: FakeRuntime["batchWorkflowStartCalls"][number]
  ) {
    this.batchWorkflowStartCalls.push(args);
    if (this.options.startLinkedInConnectBatchWorkflow) {
      return this.options.startLinkedInConnectBatchWorkflow(args);
    }
    return {
      workflowId: "workflow-batch",
      runId: "workflow-run-batch",
    };
  }

  async getAgentTaskWorkflowStatus(args: FakeRuntime["workflowStatusCalls"][number]) {
    this.workflowStatusCalls.push(args);
    if (this.options.getAgentTaskWorkflowStatus) {
      return this.options.getAgentTaskWorkflowStatus(args);
    }
    return {
      status: "completed",
      running: false,
      completed: true,
      result: {
        value: {
          summary: "Agent completed through workflow polling.",
          metadata: {
            kind: "execute_agent_task",
            finalUrl: "https://example.com/final",
            taskSteps: [
              {
                title: "Inspect the page",
                resultSummary: "Verified the current page state.",
              },
            ],
          },
        },
        metadata: {
          workflowName: "GenericBrowserTaskWorkflow",
          attempts: 1,
          recovered: false,
        },
      },
      state: {
        metadata: {
          attempts: 1,
        },
      },
    };
  }

  async resumeAgentTaskWorkflow(args: FakeRuntime["workflowResumeCalls"][number]) {
    this.workflowResumeCalls.push(args);
    if (this.options.resumeAgentTaskWorkflow) {
      return this.options.resumeAgentTaskWorkflow(args);
    }
    return true;
  }

  async cancelAgentTaskWorkflow(args: FakeRuntime["workflowCancelCalls"][number]) {
    this.workflowCancelCalls.push(args);
    if (this.options.cancelAgentTaskWorkflow) {
      return this.options.cancelAgentTaskWorkflow(args);
    }
    return true;
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
  const service = new LocalAgentCompanionService(
    store,
    runtime as never,
    createNoopCompanionLogger()
  );
  services.push(service);
  return {
    service,
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
    services.splice(0).map((service) => service.dispose())
  );
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
    const runtime = new FakeRuntime({
      executeAgentTask: async (args) => ({
        summary: `Agent completed: ${args.goal}`,
        metadata: {
          kind: "execute_agent_task",
          finalUrl: "https://mail.google.com/mail/u/0/#drafts",
        },
      }),
    });
    const { service } = await createTestService(runtime);

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
    expect(pending.runs[0]?.progress?.totalTasks).toBe(1);
    expect(pending.runs[0]?.tasks?.[0]?.title).toBe("Draft and place browser response");
    expect(pending.approvals).toHaveLength(0);
    expect(runtime.draftCalls).toHaveLength(0);

    const completed = await waitForRunStatus(service, "user:1", "completed");
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]).toMatchObject({
      goal: "Reply to this recruiter",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabcd",
      platformHint: "gmail",
      userContext: "I build backend and AI agent tooling for recruiting workflows.",
      systemPrompt: "Be direct and avoid fluff.",
    });
    expect(completed.approvals).toHaveLength(0);
    expect(completed.runs[0]?.status).toBe("completed");
    expect(completed.runs[0]?.latestSummary).toContain("Agent completed");
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 1,
      completedTasks: 1,
      currentTaskIndex: 1,
      latestPageUrl: "https://mail.google.com/mail/u/0/#drafts",
    });
    expect(completed.runs[0]?.tasks?.[0]).toMatchObject({
      status: "completed",
      pageUrl: "https://mail.google.com/mail/u/0/#drafts",
    });
  });

  test("passes resume files through to the python mcp-agent runtime", async () => {
    const { service, runtime } = await createTestService();

    await service.startRun({
      userScope: "user:resume-file",
      goal: "Apply to this role and upload my resume",
      platformHint: "greenhouse",
      pageUrl: "https://boards.greenhouse.io/example/jobs/123",
      userContext: "Use my stored job application profile where relevant.",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
      resumeFile: {
        name: "resume.pdf",
        mimeType: "application/pdf",
        base64: "ZmFrZS1wZGYtYnl0ZXM=",
      },
    });

    await waitForRunStatus(service, "user:resume-file", "completed");

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.resumeFile).toEqual({
      name: "resume.pdf",
      mimeType: "application/pdf",
      base64: "ZmFrZS1wZGYtYnl0ZXM=",
    });
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
    const runtime = new FakeRuntime({
      executeAgentTask: async (args) => ({
        summary: `Agent completed: ${args.goal}`,
        metadata: {
          kind: "execute_agent_task",
          finalUrl: "https://www.linkedin.com/company/example/life/",
          taskSteps: [
            {
              title: "Inspect the current company page",
              resultSummary: "Verified the hiring and life tabs from the live page.",
            },
            {
              title: "Open and inspect the hiring section",
              resultSummary: "Opened the hiring section and confirmed the active openings area.",
            },
          ],
        },
      }),
    });
    const { service } = await createTestService(runtime);

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
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 2,
      currentTaskIndex: 2,
      latestPageUrl: "https://www.linkedin.com/company/example/life/",
    });
    expect(completed.runs[0]?.tasks).toMatchObject([
      {
        title: "Inspect the current company page",
        status: "completed",
        resultSummary: "Verified the hiring and life tabs from the live page.",
      },
      {
        title: "Open and inspect the hiring section",
        status: "completed",
        resultSummary: "Opened the hiring section and confirmed the active openings area.",
      },
    ]);
  });

  test("uses managed async workflow polling for generic tasks when the runtime supports it", async () => {
    let statusPollCount = 0;
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      startAgentTaskWorkflow: async () => ({
        workflowId: "workflow-123",
        runId: "run-abc",
      }),
      getAgentTaskWorkflowStatus: async () => {
        statusPollCount += 1;
        if (statusPollCount === 1) {
          return {
            status: "running",
            running: true,
            completed: false,
            state: {
              metadata: {
                attempts: 2,
              },
            },
          };
        }
        return {
          status: "completed",
          running: false,
          completed: true,
          result: {
            value: {
              summary: "Managed workflow completed the browser task.",
              metadata: {
                kind: "execute_agent_task",
                finalUrl: "https://example.com/done",
                taskSteps: [
                  {
                    title: "Inspect the current page",
                    resultSummary: "Verified the relevant controls on the live page.",
                  },
                  {
                    title: "Complete the requested browser action",
                    resultSummary: "Performed the action and verified the final state.",
                  },
                ],
              },
            },
            metadata: {
              workflowName: "GenericBrowserTaskWorkflow",
              attempts: 2,
              recovered: true,
            },
          },
          state: {
            metadata: {
              attempts: 2,
            },
          },
        };
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:workflow",
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

    const completed = await waitForRunStatus(service, "user:workflow", "completed");

    expect(runtime.workflowStartCalls).toHaveLength(1);
    expect(runtime.workflowStatusCalls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.agentTaskCalls).toHaveLength(0);
    expect(completed.runs[0]).toMatchObject({
      workflowId: "workflow-123",
      workflowRunId: "run-abc",
      workflowStatus: "completed",
      status: "completed",
    });
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 2,
      currentTaskIndex: 2,
      latestPageUrl: "https://example.com/done",
    });
  });

  test("aligns explicit navigation goals with the requested destination before managed workflow planning", async () => {
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      deriveBrowserWorkItems: async () => ({
        mode: "single",
        summary: "A single Google search is enough for this goal.",
        workItems: [],
      }),
      startAgentTaskWorkflow: async () => ({
        workflowId: "workflow-google-123",
        runId: "run-google-abc",
      }),
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary: "Opened Google and searched for sajan poudel.",
            metadata: {
              kind: "execute_agent_task",
              finalUrl: "https://www.google.com/search?q=sajan+poudel",
            },
          },
          metadata: {
            workflowName: "GenericBrowserTaskWorkflow",
            attempts: 1,
            recovered: false,
          },
        },
        state: {
          metadata: {
            attempts: 1,
            latestPageUrl: "https://www.google.com/search?q=sajan+poudel",
          },
        },
      }),
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:explicit-google-goal",
      goal: "go to google.com and search sajan poudel",
      platformHint: "general",
      pageUrl:
        "https://www.cheatresume.com/jobs?sort=relevance&jobType=software-engineering",
      pageContext: "Page: CheatResume\nVisible context: Auto-Apply Credits 0 / 500",
      workItems: [
        {
          title: "Handle Associate Software Engineer",
          pageUrl: "https://www.cheatresume.com/jobs/associate-software-engineer",
          targetUrl: "https://www.cheatresume.com/jobs/associate-software-engineer",
          targetName: "Associate Software Engineer",
          itemContext: "Job card visible on CheatResume.",
          sourceType: "page_link",
        },
        {
          title: "Handle Junior Data Scientist",
          pageUrl: "https://www.cheatresume.com/jobs/junior-data-scientist",
          targetUrl: "https://www.cheatresume.com/jobs/junior-data-scientist",
          targetName: "Junior Data Scientist",
          itemContext: "Another job card visible on CheatResume.",
          sourceType: "page_link",
        },
      ],
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:explicit-google-goal",
      "completed"
    );

    expect(runtime.workItemDiscoveryCalls).toHaveLength(1);
    expect(runtime.workItemDiscoveryCalls[0]).toMatchObject({
      goal: "go to google.com and search sajan poudel",
      pageUrl: "https://www.google.com/",
    });
    expect(runtime.workItemDiscoveryCalls[0]?.pageContext).toBeUndefined();
    expect(runtime.workItemDiscoveryCalls[0]?.workItems).toBeUndefined();
    expect(runtime.queueWorkflowStartCalls).toHaveLength(0);
    expect(runtime.workflowStartCalls).toHaveLength(1);
    expect(runtime.workflowStartCalls[0]).toMatchObject({
      goal: "go to google.com and search sajan poudel",
      pageUrl: "https://www.google.com/",
    });
    expect(runtime.workflowStartCalls[0]?.pageContext).toBeUndefined();
    expect(runtime.workflowStartCalls[0]?.workItems).toBeUndefined();
    expect(completed.runs[0]?.status).toBe("completed");
    expect(completed.runs[0]?.tasks?.[0]?.title).toBe(
      "go to google.com and search sajan poudel"
    );
    expect(completed.runs[0]?.tasks?.[0]?.pageUrl).toBe(
      "https://www.google.com/search?q=sajan+poudel"
    );
  });

  test("does not reuse prior Google homepage context for a different search goal", async () => {
    const { service, store, runtime } = await createTestService();

    const priorRun = await store.createRun({
      userScope: "user:google-bounded",
      goal: "search sajan poudel northern kentucky university phone number on google",
      platformHint: "general",
      pageUrl: "https://www.google.com/",
      siteMemory: {
        host: "www.google.com",
        pagePattern: "www.google.com/search",
        workflowName: "GenericBrowserTaskWorkflow",
        summary: "Expanded the search query with extra profile facts.",
        terminalStatus: "failed",
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 1,
        completedTasks: 0,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 0,
        latestPageUrl: "https://www.google.com/",
      },
      tasks: [
        {
          _id: "task_google_prior",
          title: "search sajan poudel northern kentucky university phone number on google",
          status: "failed",
          retryCount: 2,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 30_000,
          completedAt: Date.now() - 30_000,
          pageUrl: "https://www.google.com/",
          lastError: "Expanded the query beyond the requested scope.",
        },
      ],
    });
    await store.updateRun("user:google-bounded", priorRun._id, {
      status: "failed",
      latestSummary: "Expanded the search query beyond the requested scope.",
      lastError: "Expanded the search query beyond the requested scope.",
    });

    await service.startRun({
      userScope: "user:google-bounded",
      goal: "go to google.com and search sajan poudel",
      platformHint: "general",
      pageUrl: "https://www.google.com/",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:google-bounded",
      "completed"
    );

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.resumeContext).toBeUndefined();
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toBeUndefined();
    expect(completed.runs[0]?.resumeSourceRunId).toBeUndefined();
  });

  test("routes multi-target runs into the generic queue workflow and preserves item progress", async () => {
    let statusPollCount = 0;
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      startGenericBrowserQueueWorkflow: async () => ({
        workflowId: "workflow-queue-123",
        runId: "run-queue-abc",
      }),
      getAgentTaskWorkflowStatus: async () => {
        statusPollCount += 1;
        if (statusPollCount === 1) {
          return {
            status: "running",
            running: true,
            completed: false,
            state: {
              metadata: {
                attempts: 1,
                latestPageUrl: "https://example.com/targets/1",
                taskSteps: [
                  {
                    title: "Handle Taylor Recruiter",
                    status: "completed",
                    resultSummary: "Opened Taylor's page and completed the requested action.",
                    pageUrl: "https://example.com/targets/1",
                  },
                  {
                    title: "Handle Jordan Recruiter",
                    status: "running",
                    pageUrl: "https://example.com/targets/2",
                  },
                ],
              },
            },
          };
        }
        return {
          status: "completed",
          running: false,
          completed: true,
          result: {
            value: {
              summary: "Queued browser workflow finished for 2 items. Completed: 1. Skipped: 1.",
              metadata: {
                kind: "execute_task_queue",
                finalUrl: "https://example.com/targets/2",
                taskSteps: [
                  {
                    title: "Handle Taylor Recruiter",
                    status: "completed",
                    resultSummary: "Opened Taylor's page and completed the requested action.",
                    pageUrl: "https://example.com/targets/1",
                  },
                  {
                    title: "Handle Jordan Recruiter",
                    status: "skipped",
                    skipReason: "The second target was already completed earlier.",
                    pageUrl: "https://example.com/targets/2",
                  },
                ],
              },
            },
            metadata: {
              workflowName: "GenericBrowserQueueWorkflow",
              itemCount: 2,
            },
          },
          state: {
            metadata: {
              latestPageUrl: "https://example.com/targets/2",
            },
          },
        };
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:queue-workflow",
      goal: "Open each recruiter page and perform the requested outreach task",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/search/results/people/",
      pageContext: "People search results with recruiter profile links visible.",
      scannedCandidates: [
        {
          targetName: "Taylor Recruiter",
          targetUrl: "https://example.com/targets/1",
          headline: "Senior Recruiter",
        },
        {
          targetName: "Jordan Recruiter",
          targetUrl: "https://example.com/targets/2",
          headline: "Technical Recruiter",
        },
      ],
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:queue-workflow",
      "completed"
    );

    expect(runtime.queueWorkflowStartCalls).toHaveLength(1);
    expect(runtime.workflowStartCalls).toHaveLength(0);
    expect(runtime.queueWorkflowStartCalls[0]?.workItems).toMatchObject([
      {
        title: "Handle Taylor Recruiter",
        pageUrl: "https://example.com/targets/1",
      },
      {
        title: "Handle Jordan Recruiter",
        pageUrl: "https://example.com/targets/2",
      },
    ]);
    expect(completed.runs[0]).toMatchObject({
      workflowId: "workflow-queue-123",
      workflowRunId: "run-queue-abc",
      workflowStatus: "completed",
      status: "completed",
    });
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      skippedTasks: 1,
      latestPageUrl: "https://example.com/targets/2",
    });
    expect(completed.runs[0]?.tasks).toMatchObject([
      {
        title: "Handle Taylor Recruiter",
        status: "completed",
      },
      {
        title: "Handle Jordan Recruiter",
        status: "skipped",
        skipReason: "The second target was already completed earlier.",
      },
    ]);
  });

  test("fails managed runs immediately when work-item discovery hits a permanent provider error", async () => {
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      deriveBrowserWorkItems: async () => {
        throw new Error(
          "LLM request failed with a permanent error (will not retry): 403 PERMISSION_DENIED. {'error': {'message': 'Gemini API has not been used in project 871197118306 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=871197118306 then retry.', 'status': 'PERMISSION_DENIED', 'details': [{'reason': 'SERVICE_DISABLED'}]}}"
        );
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:managed-provider-failure",
      goal: "go to google.com and search sajan poudel",
      platformHint: "general",
      pageUrl:
        "https://www.cheatresume.com/jobs?sort=relevance&jobType=software-engineering",
      pageContext: "Page: CheatResume\nVisible context: Auto-Apply Credits 0 / 500",
      workItems: [
        {
          title: "Handle Associate Software Engineer",
          pageUrl: "https://www.cheatresume.com/jobs/associate-software-engineer",
          targetUrl: "https://www.cheatresume.com/jobs/associate-software-engineer",
          targetName: "Associate Software Engineer",
          itemContext: "Job card visible on CheatResume.",
          sourceType: "page_link",
        },
        {
          title: "Handle Junior Data Scientist",
          pageUrl: "https://www.cheatresume.com/jobs/junior-data-scientist",
          targetUrl: "https://www.cheatresume.com/jobs/junior-data-scientist",
          targetName: "Junior Data Scientist",
          itemContext: "Another job card visible on CheatResume.",
          sourceType: "page_link",
        },
      ],
      providerConfig: {
        provider: "google",
        apiKey: "test-key",
        model: "gemini-2.5-flash",
      },
    });

    const failed = await waitForRunStatus(
      service,
      "user:managed-provider-failure",
      "failed"
    );

    expect(runtime.workItemDiscoveryCalls).toHaveLength(1);
    expect(runtime.queueWorkflowStartCalls).toHaveLength(0);
    expect(runtime.workflowStartCalls).toHaveLength(0);
    expect(failed.runs[0]?.status).toBe("failed");
    expect(failed.runs[0]?.lastError).toContain("PERMISSION_DENIED");
    expect(failed.runs[0]?.tasks?.[0]?.status).toBe("failed");
    expect(failed.runs[0]?.tasks?.[0]?.title).toBe(
      "go to google.com and search sajan poudel"
    );
  });

  test("can derive durable work items from the runtime before starting a queue workflow", async () => {
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      deriveBrowserWorkItems: async () => ({
        mode: "queue",
        summary: "The page exposes two repeated recruiter targets.",
        workItems: [
          {
            title: "Handle Taylor Recruiter",
            pageUrl: "https://example.com/profiles/taylor",
            targetName: "Taylor Recruiter",
            itemContext: "Senior recruiter profile row",
            sourceType: "agent_discovered",
          },
          {
            title: "Handle Jordan Hiring",
            pageUrl: "https://example.com/profiles/jordan",
            targetName: "Jordan Hiring",
            itemContext: "Technical recruiter profile row",
            sourceType: "agent_discovered",
          },
        ],
      }),
      startGenericBrowserQueueWorkflow: async () => ({
        workflowId: "workflow-derived-queue",
        runId: "workflow-run-derived-queue",
      }),
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary:
              "Queued browser workflow finished for 2 items. Completed: 2.",
            metadata: {
              kind: "execute_task_queue",
              finalUrl: "https://example.com/profiles/jordan",
              taskSteps: [
                {
                  title: "Handle Taylor Recruiter",
                  status: "completed",
                  pageUrl: "https://example.com/profiles/taylor",
                },
                {
                  title: "Handle Jordan Hiring",
                  status: "completed",
                  pageUrl: "https://example.com/profiles/jordan",
                },
              ],
            },
          },
        },
        state: {
          metadata: {
            latestPageUrl: "https://example.com/profiles/jordan",
          },
        },
      }),
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:derived-queue",
      goal: "Review the visible recruiters and perform the requested outreach task",
      platformHint: "general",
      pageUrl: "https://example.com/recruiters",
      pageContext: "Recruiter directory page with multiple visible profile links.",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:derived-queue",
      "completed"
    );

    expect(runtime.workItemDiscoveryCalls).toHaveLength(1);
    expect(runtime.queueWorkflowStartCalls).toHaveLength(1);
    expect(runtime.workflowStartCalls).toHaveLength(0);
    expect(runtime.queueWorkflowStartCalls[0]?.workItems).toMatchObject([
      {
        title: "Handle Taylor Recruiter",
        pageUrl: "https://example.com/profiles/taylor",
      },
      {
        title: "Handle Jordan Hiring",
        pageUrl: "https://example.com/profiles/jordan",
      },
    ]);
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 2,
      currentTaskIndex: 2,
      latestPageUrl: "https://example.com/profiles/jordan",
    });
    expect(completed.runs[0]?.tasks).toMatchObject([
      {
        title: "Handle Taylor Recruiter",
        status: "completed",
      },
      {
        title: "Handle Jordan Hiring",
        status: "completed",
      },
    ]);
  });

  test("treats provisional repeated work items as hints and still asks the runtime to refine them", async () => {
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      deriveBrowserWorkItems: async () => ({
        mode: "single",
        summary: "The live page analysis did not return a better queue plan.",
        workItems: [],
      }),
      startGenericBrowserQueueWorkflow: async () => ({
        workflowId: "workflow-provisional-queue",
        runId: "workflow-run-provisional-queue",
      }),
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary:
              "Queued browser workflow finished for 2 items. Completed: 2.",
            metadata: {
              kind: "execute_task_queue",
              finalUrl: "https://example.com/jobs/2",
              taskSteps: [
                {
                  title: "Handle Backend Engineer",
                  status: "completed",
                  pageUrl: "https://example.com/jobs/1",
                },
                {
                  title: "Handle Platform Engineer",
                  status: "completed",
                  pageUrl: "https://example.com/jobs/2",
                },
              ],
            },
          },
        },
        state: {
          metadata: {
            latestPageUrl: "https://example.com/jobs/2",
          },
        },
      }),
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:provisional-queue",
      goal: "Review the visible jobs and queue the strong matches",
      platformHint: "general",
      pageUrl: "https://example.com/jobs",
      pageContext: "Jobs page with repeated cards.",
      workItems: [
        {
          title: "Handle Backend Engineer",
          pageUrl: "https://example.com/jobs/1",
          itemContext: "Backend-heavy role",
          sourceType: "page_link",
        },
        {
          title: "Handle Platform Engineer",
          pageUrl: "https://example.com/jobs/2",
          itemContext: "Platform-heavy role",
          sourceType: "page_link",
        },
      ],
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:provisional-queue",
      "completed"
    );

    expect(runtime.workItemDiscoveryCalls).toHaveLength(1);
    expect(runtime.workItemDiscoveryCalls[0]?.workItems).toMatchObject([
      {
        title: "Handle Backend Engineer",
        pageUrl: "https://example.com/jobs/1",
        sourceType: "page_link",
      },
      {
        title: "Handle Platform Engineer",
        pageUrl: "https://example.com/jobs/2",
        sourceType: "page_link",
      },
    ]);
    expect(runtime.queueWorkflowStartCalls).toHaveLength(1);
    expect(runtime.queueWorkflowStartCalls[0]?.workItems).toMatchObject([
      {
        title: "Handle Backend Engineer",
        pageUrl: "https://example.com/jobs/1",
        sourceType: "page_link",
      },
      {
        title: "Handle Platform Engineer",
        pageUrl: "https://example.com/jobs/2",
        sourceType: "page_link",
      },
    ]);
    expect(runtime.workflowStartCalls).toHaveLength(0);
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 2,
      currentTaskIndex: 2,
    });
  });

  test("recovers an executing managed workflow after the companion restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "text-fill-companion-recovery-"));
    tempDirs.push(dir);
    const store = new CompanionStateStore(join(dir, "state.json"));
    const createdRun = await store.createRun({
      userScope: "user:restart-recovery",
      goal: "Continue the browser task after a backend restart",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/company/example/",
      pageContext: "Company page with hiring information visible.",
      progress: {
        totalTasks: 1,
        completedTasks: 0,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 0,
        latestPageUrl: "https://www.linkedin.com/company/example/",
        resumeCursor: "task_restart_recovery",
      },
      tasks: [
        {
          _id: "task_restart_recovery",
          title: "Finish the browser workflow",
          status: "running",
          retryCount: 0,
          createdAt: Date.now() - 20_000,
          updatedAt: Date.now() - 5_000,
          pageUrl: "https://www.linkedin.com/company/example/",
        },
      ],
    });
    await store.updateRun("user:restart-recovery", createdRun._id, {
      status: "executing",
      workflowId: "workflow-recovered",
      workflowRunId: "workflow-run-recovered",
      workflowStatus: "running",
      latestSummary: "Workflow running before the companion restarted.",
    });

    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary: "Recovered workflow completed after the companion restart.",
            metadata: {
              kind: "execute_agent_task",
              finalUrl: "https://www.linkedin.com/company/example/hiring/",
              taskSteps: [
                {
                  title: "Reconnect to the existing workflow",
                  resultSummary: "Recovered the in-flight workflow from Temporal.",
                },
                {
                  title: "Finish the requested browser task",
                  resultSummary: "Completed the remaining browser steps.",
                },
              ],
            },
          },
          metadata: {
            workflowName: "GenericBrowserTaskWorkflow",
            attempts: 1,
            recovered: false,
          },
        },
        state: {
          metadata: {
            attempts: 1,
            latestPageUrl: "https://www.linkedin.com/company/example/hiring/",
          },
        },
      }),
    });
    const service = new LocalAgentCompanionService(
      store,
      runtime as never,
      createNoopCompanionLogger()
    );
    services.push(service);

    await service.getPanelState({
      userScope: "user:restart-recovery",
      limit: 5,
    });

    const completed = await waitForRunStatus(
      service,
      "user:restart-recovery",
      "completed"
    );
    expect(runtime.workflowStatusCalls.length).toBeGreaterThan(0);
    expect(runtime.workflowStatusCalls[0]).toMatchObject({
      workflowId: "workflow-recovered",
      runId: "workflow-run-recovered",
    });
    expect(completed.runs[0]).toMatchObject({
      _id: createdRun._id,
      status: "completed",
      workflowStatus: "completed",
      latestSummary: expect.stringContaining(
        "Recovered workflow completed after the companion restart."
      ),
    });
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 2,
      currentTaskIndex: 2,
      latestPageUrl: "https://www.linkedin.com/company/example/hiring/",
    });
  });

  test("cancels a managed workflow-backed run without remapping it to failed", async () => {
    let cancelled = false;
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      startAgentTaskWorkflow: async () => ({
        workflowId: "workflow-cancel",
        runId: "workflow-run-cancel",
      }),
      getAgentTaskWorkflowStatus: async () => {
        if (cancelled) {
          return {
            status: "cancelled",
            running: false,
            completed: false,
            error: "Workflow cancelled",
            state: {
              metadata: {
                attempts: 1,
              },
            },
          };
        }
        return {
          status: "running",
          running: true,
          completed: false,
          state: {
            metadata: {
              attempts: 1,
            },
          },
        };
      },
      cancelAgentTaskWorkflow: async () => {
        cancelled = true;
        return true;
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:cancel-workflow",
      goal: "Open the current LinkedIn company page and inspect the hiring section",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/company/example/",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    await waitForRunStatus(service, "user:cancel-workflow", "executing");

    const cancelledResult = await service.cancelRun({
      userScope: "user:cancel-workflow",
      runId: (
        await service.getPanelState({
          userScope: "user:cancel-workflow",
          limit: 5,
        })
      ).runs[0]!._id,
    });

    expect(cancelledResult).toMatchObject({
      ok: true,
      status: "cancelled",
    });

    const cancelledState = await waitForRunStatus(
      service,
      "user:cancel-workflow",
      "cancelled"
    );
    expect(runtime.workflowCancelCalls).toHaveLength(1);
    expect(cancelledState.runs[0]).toMatchObject({
      status: "cancelled",
      workflowStatus: "cancelled",
    });
    expect(cancelledState.runs[0]?.lastError).toBeUndefined();
  });

  test("resumes a paused managed workflow in place", async () => {
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      resumeAgentTaskWorkflow: async () => true,
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary: "Paused workflow resumed and completed the browser task.",
            metadata: {
              kind: "execute_agent_task",
              finalUrl: "https://example.com/resumed",
              taskSteps: [
                {
                  title: "Continue the paused workflow",
                  resultSummary: "Completed the remaining browser action.",
                },
              ],
            },
          },
          metadata: {
            workflowName: "GenericBrowserTaskWorkflow",
            attempts: 2,
            recovered: true,
          },
        },
        state: {
          metadata: {
            attempts: 2,
          },
        },
      }),
    });
    const { service, store } = await createTestService(runtime);

    const pausedRun = await store.createRun({
      userScope: "user:paused-resume",
      goal: "Continue applying to this job",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/444/apply",
      progress: {
        totalTasks: 1,
        completedTasks: 0,
        skippedTasks: 0,
        blockedTasks: 1,
        retryingTasks: 0,
        currentTaskIndex: 0,
        latestPageUrl: "https://www.linkedin.com/jobs/view/444/apply",
        resumeCursor: "task_paused",
      },
      tasks: [
        {
          _id: "task_paused",
          title: "Finish the current job application",
          status: "blocked",
          retryCount: 1,
          createdAt: Date.now() - 20_000,
          updatedAt: Date.now() - 5_000,
          pageUrl: "https://www.linkedin.com/jobs/view/444/apply",
        },
      ],
    });
    await store.updateRun("user:paused-resume", pausedRun._id, {
      status: "paused",
      workflowId: "workflow-paused",
      workflowRunId: "workflow-run-paused",
      workflowStatus: "paused",
      latestSummary: "Workflow paused inside the local Chrome runtime.",
    });

    const resumed = await service.resumeRun({
      userScope: "user:paused-resume",
      runId: pausedRun._id,
      pageUrl: "https://www.linkedin.com/jobs/view/444/apply",
      pageContext: "Easy Apply is open on the review step.",
      userContext: "Use the user's saved work experience and concise tone.",
      systemPrompt: "Be precise and continue from the last completed browser step.",
      resumeFile: {
        name: "resume.pdf",
        mimeType: "application/pdf",
        base64: "cGRmLWJ5dGVz",
      },
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    expect(resumed).toMatchObject({
      ok: true,
      status: "executing",
      runId: pausedRun._id,
      resumedExistingRun: true,
      sourceRunId: pausedRun._id,
    });

    const completed = await waitForRunStatus(
      service,
      "user:paused-resume",
      "completed"
    );
    expect(runtime.workflowResumeCalls).toHaveLength(1);
    expect(runtime.workflowResumeCalls[0]).toMatchObject({
      workflowId: "workflow-paused",
      runId: "workflow-run-paused",
      signalName: "resume",
      payload: {
        pageUrl: "https://www.linkedin.com/jobs/view/444/apply",
        pageContext: "Easy Apply is open on the review step.",
        userContext: "Use the user's saved work experience and concise tone.",
        systemPrompt:
          "Be precise and continue from the last completed browser step.",
        resumeFile: {
          name: "resume.pdf",
          mimeType: "application/pdf",
          base64: "cGRmLWJ5dGVz",
        },
      },
    });
    expect(completed.runs[0]).toMatchObject({
      _id: pausedRun._id,
      status: "completed",
      workflowStatus: "completed",
    });
  });

  test("creates a continuation run when resuming a failed run explicitly", async () => {
    const { service, store, runtime } = await createTestService();

    const failedRun = await store.createRun({
      userScope: "user:explicit-resume",
      goal: "Apply to software engineering jobs on this site",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/555",
      pageContext: "LinkedIn Easy Apply flow in progress.",
      progress: {
        totalTasks: 2,
        completedTasks: 1,
        skippedTasks: 0,
        blockedTasks: 1,
        retryingTasks: 0,
        currentTaskIndex: 1,
        latestPageUrl: "https://www.linkedin.com/jobs/view/555/apply",
        lastCheckpointAt: Date.now() - 30_000,
        resumeCursor: "task_resume_failed",
      },
      tasks: [
        {
          _id: "task_resume_done",
          title: "Open the job application",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 50_000,
          completedAt: Date.now() - 50_000,
          pageUrl: "https://www.linkedin.com/jobs/view/555",
        },
        {
          _id: "task_resume_failed",
          title: "Fill required application fields",
          status: "failed",
          retryCount: 2,
          createdAt: Date.now() - 49_000,
          updatedAt: Date.now() - 20_000,
          completedAt: Date.now() - 20_000,
          pageUrl: "https://www.linkedin.com/jobs/view/555/apply",
          lastError: "Phone number field validation blocked submission",
        },
      ],
    });
    await store.updateRun("user:explicit-resume", failedRun._id, {
      status: "failed",
      latestSummary: "Stopped at the phone number validation step.",
      lastError: "Phone number field validation blocked submission",
    });

    const resumed = await service.resumeRun({
      userScope: "user:explicit-resume",
      runId: failedRun._id,
      pageUrl: "https://www.linkedin.com/jobs/view/555/apply",
      resumeFile: {
        name: "resume.pdf",
        mimeType: "application/pdf",
        base64: "cmVzdW1lLWJ5dGVz",
      },
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    expect(resumed.ok).toBe(true);
    expect(resumed.resumedExistingRun).toBe(false);
    expect(resumed.sourceRunId).toBe(failedRun._id);
    expect(resumed.runId).not.toBe(failedRun._id);

    const completed = await waitForRunStatus(
      service,
      "user:explicit-resume",
      "completed"
    );

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.resumeContext).toContain(
      "Continuation context from the previous interrupted run"
    );
    expect(runtime.agentTaskCalls[0]?.resumeContext).toContain(
      "Phone number field validation blocked submission"
    );
    expect(runtime.agentTaskCalls[0]?.resumeFile).toEqual({
      name: "resume.pdf",
      mimeType: "application/pdf",
      base64: "cmVzdW1lLWJ5dGVz",
    });
    expect(completed.runs[0]?.resumeSourceRunId).toBe(failedRun._id);
  });

  test("records failed primary task progress when the runtime errors", async () => {
    const runtime = new FakeRuntime({
      executeAgentTask: async () => {
        throw new Error("Element not found after navigation");
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:failure",
      goal: "Apply to this job",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/123",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const failed = await waitForRunStatus(service, "user:failure", "failed");

    expect(failed.runs[0]?.progress).toMatchObject({
      totalTasks: 1,
      completedTasks: 0,
      blockedTasks: 1,
      latestPageUrl: "https://www.linkedin.com/jobs/view/123",
    });
    expect(failed.runs[0]?.tasks?.[0]).toMatchObject({
      status: "failed",
      lastError: "Element not found after navigation",
    });
    expect(failed.runs[0]?.lastError).toBe("Element not found after navigation");
  });

  test("does not add companion-level retries when the runtime manages generic task retries itself", async () => {
    let attempts = 0;
    const runtime = new FakeRuntime({
      supportsManagedTaskRetries: true,
      executeAgentTask: async () => {
        attempts += 1;
        throw new Error("Generic workflow exhausted its own retries");
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:managed-retries",
      goal: "Apply to this job",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/991",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const failed = await waitForRunStatus(service, "user:managed-retries", "failed");

    expect(attempts).toBe(1);
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(failed.runs[0]?.lastError).toBe("Generic workflow exhausted its own retries");
  });

  test("retries retryable agent failures and clears stale task errors after recovery", async () => {
    let attempts = 0;
    const runtime = new FakeRuntime({
      executeAgentTask: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`Transient navigation failure ${attempts}`);
        }
        return {
          summary: "Recovered and completed the browser task.",
          metadata: {
            kind: "execute_agent_task",
            finalUrl: "https://www.linkedin.com/jobs/view/789",
          },
        };
      },
    });
    const { service } = await createTestService(runtime);

    await service.startRun({
      userScope: "user:retry",
      goal: "Apply to this job",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/789",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(service, "user:retry", "completed");

    expect(runtime.agentTaskCalls).toHaveLength(3);
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 1,
      completedTasks: 1,
      blockedTasks: 0,
      retryingTasks: 0,
      latestPageUrl: "https://www.linkedin.com/jobs/view/789",
    });
    expect(completed.runs[0]?.tasks?.[0]).toMatchObject({
      status: "completed",
      retryCount: 2,
      pageUrl: "https://www.linkedin.com/jobs/view/789",
    });
    expect(completed.runs[0]?.tasks?.[0]?.lastError).toBeUndefined();
    expect(completed.runs[0]?.lastError).toBeUndefined();
  });

  test("passes continuation context from the last interrupted run into a resume request", async () => {
    const { service, store, runtime } = await createTestService();

    const priorRun = await store.createRun({
      userScope: "user:resume",
      goal: "Apply to software engineering jobs on this site",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/555",
      progress: {
        totalTasks: 3,
        completedTasks: 1,
        skippedTasks: 0,
        blockedTasks: 1,
        retryingTasks: 0,
        currentTaskIndex: 1,
        latestPageUrl: "https://www.linkedin.com/jobs/view/555",
        lastCheckpointAt: Date.now() - 30_000,
        resumeCursor: "task_resume_2",
      },
      tasks: [
        {
          _id: "task_resume_1",
          title: "Open the job application",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 45_000,
          completedAt: Date.now() - 45_000,
          pageUrl: "https://www.linkedin.com/jobs/view/555",
        },
        {
          _id: "task_resume_2",
          title: "Fill required application fields",
          status: "failed",
          retryCount: 2,
          createdAt: Date.now() - 44_000,
          updatedAt: Date.now() - 20_000,
          completedAt: Date.now() - 20_000,
          pageUrl: "https://www.linkedin.com/jobs/view/555/apply",
          lastError: "Phone number field validation blocked submission",
        },
      ],
    });
    await store.updateRun("user:resume", priorRun._id, {
      status: "failed",
      latestSummary: "Stopped at the phone number validation step.",
      lastError: "Phone number field validation blocked submission",
    });

    await service.startRun({
      userScope: "user:resume",
      goal: "Continue from where you left off",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/555/apply",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(service, "user:resume", "completed");

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.resumeContext).toContain(
      "Continuation context from the previous interrupted run"
    );
    expect(runtime.agentTaskCalls[0]?.resumeContext).toContain(
      "Stopped at the phone number validation step."
    );
    expect(runtime.agentTaskCalls[0]?.resumeContext).toContain(
      "Current task: Fill required application fields"
    );
    expect(completed.runs[0]?.resumeSourceRunId).toBeTruthy();
  });

  test("passes compact site experience from similar runs into new agent tasks", async () => {
    const { service, store, runtime } = await createTestService();

    await store.createRun({
      userScope: "user:site-memory",
      goal: "Apply to a similar job on LinkedIn",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/100",
      siteMemory: {
        host: "www.linkedin.com",
        pagePattern: "www.linkedin.com/jobs/view/:id",
        workflowName: "GenericBrowserTaskWorkflow",
        summary: "Easy Apply succeeded after verifying required fields before submit.",
        terminalStatus: "completed",
        taskPatterns: [
          {
            title: "Submit the LinkedIn Easy Apply form",
            status: "completed",
            pagePattern: "www.linkedin.com/jobs/view/:id",
            resultSummary:
              "Verified required fields before submit and completed Easy Apply.",
          },
        ],
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 1,
        completedTasks: 1,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 1,
        latestPageUrl: "https://www.linkedin.com/jobs/view/100",
      },
      tasks: [
        {
          _id: "task_success",
          title: "Submit the LinkedIn Easy Apply form",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 55_000,
          completedAt: Date.now() - 55_000,
          pageUrl: "https://www.linkedin.com/jobs/view/100",
        },
      ],
    }).then((run) =>
      store.updateRun("user:site-memory", run._id, {
        status: "completed",
        latestSummary: "Easy Apply succeeded after verifying required fields before submit.",
      })
    );

    await store.createRun({
      userScope: "user:site-memory",
      goal: "Apply to another LinkedIn role",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/101",
      siteMemory: {
        host: "www.linkedin.com",
        pagePattern: "www.linkedin.com/jobs/view/:id",
        workflowName: "GenericBrowserTaskWorkflow",
        summary: "The form blocked submit because the phone field was empty.",
        lastError: "Phone number validation blocked submission",
        terminalStatus: "failed",
        taskPatterns: [
          {
            title: "Fill required application fields",
            status: "failed",
            pagePattern: "www.linkedin.com/jobs/view/:id/apply",
            lastError: "Phone number validation blocked submission",
          },
        ],
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 1,
        completedTasks: 0,
        skippedTasks: 0,
        blockedTasks: 1,
        retryingTasks: 0,
        currentTaskIndex: 0,
        latestPageUrl: "https://www.linkedin.com/jobs/view/101/apply",
      },
      tasks: [
        {
          _id: "task_failure",
          title: "Fill required application fields",
          status: "failed",
          retryCount: 1,
          createdAt: Date.now() - 40_000,
          updatedAt: Date.now() - 35_000,
          completedAt: Date.now() - 35_000,
          pageUrl: "https://www.linkedin.com/jobs/view/101/apply",
          lastError: "Phone number validation blocked submission",
        },
      ],
    }).then((run) =>
      store.updateRun("user:site-memory", run._id, {
        status: "failed",
        latestSummary: "The form blocked submit because the phone field was empty.",
        lastError: "Phone number validation blocked submission",
      })
    );

    await service.startRun({
      userScope: "user:site-memory",
      goal: "Apply to this software engineering job",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/102",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:site-memory",
      "completed"
    );

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Reusable structured memory from similar pages on this site."
    );
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Easy Apply succeeded after verifying required fields before submit."
    );
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Failure patterns to avoid or verify before retrying:"
    );
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Phone number validation blocked submission"
    );
    expect(completed.runs[0]?.status).toBe("completed");
  });

  test("does not promote plain completed summaries into reusable site memory", async () => {
    const { service, store, runtime } = await createTestService();

    await store.createRun({
      userScope: "user:summary-only-memory",
      goal: "Summarize a job page",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?q=platform",
      progress: {
        totalTasks: 1,
        completedTasks: 1,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 1,
        latestPageUrl: "https://jobs.example.com/search?q=platform",
      },
      tasks: [
        {
          _id: "task_summary_only",
          title: "Summarize the visible jobs",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 5_000,
          updatedAt: Date.now() - 4_000,
          completedAt: Date.now() - 4_000,
          pageUrl: "https://jobs.example.com/search?q=platform",
        },
      ],
    }).then((run) =>
      store.updateRun("user:summary-only-memory", run._id, {
        status: "completed",
        latestSummary: "Summarized the job list successfully.",
      })
    );

    await service.startRun({
      userScope: "user:summary-only-memory",
      goal: "Review the next page of results",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?page=2&q=platform",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    await waitForRunStatus(service, "user:summary-only-memory", "completed");
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toBeUndefined();
  });

  test("only surfaces completed step patterns as reusable success guidance", async () => {
    const { service, store, runtime } = await createTestService();

    await store.createRun({
      userScope: "user:completed-patterns-only",
      goal: "Work through the current jobs queue",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?q=backend",
      siteMemory: {
        host: "jobs.example.com",
        pagePattern: "jobs.example.com/search",
        workflowName: "GenericBrowserQueueWorkflow",
        summary: "Completed the durable queue workflow.",
        terminalStatus: "completed",
        taskPatterns: [
          {
            title: "Open backend role",
            status: "completed",
            resultSummary: "Opened the role and verified it matched the goal.",
          },
          {
            title: "Broken retry path",
            status: "failed",
            lastError: "The retry loop clicked the wrong card.",
          },
        ],
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 2,
        completedTasks: 2,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 2,
        latestPageUrl: "https://jobs.example.com/job/2",
      },
      tasks: [
        {
          _id: "task_completed_pattern",
          title: "Open backend role",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 5_000,
          updatedAt: Date.now() - 4_000,
          completedAt: Date.now() - 4_000,
          pageUrl: "https://jobs.example.com/job/2",
        },
      ],
    }).then((run) =>
      store.updateRun("user:completed-patterns-only", run._id, {
        status: "completed",
        latestSummary: "Completed the durable queue workflow.",
      })
    );

    await service.startRun({
      userScope: "user:completed-patterns-only",
      goal: "Review the next page of backend jobs",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?page=2&q=backend",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    await waitForRunStatus(service, "user:completed-patterns-only", "completed");
    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Open backend role · completed"
    );
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).not.toContain(
      "Broken retry path"
    );
  });

  test("persists structured site memory on completed managed workflows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "text-fill-companion-site-memory-"));
    tempDirs.push(dir);

    const store1 = new CompanionStateStore(join(dir, "state.json"));
    const runtime1 = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      deriveBrowserWorkItems: async () => ({
        mode: "queue",
        summary: "The jobs page exposes repeated actionable cards.",
        workItems: [
          {
            title: "Handle Backend Engineer",
            pageUrl: "https://jobs.example.com/job/1",
            itemContext: "Backend-heavy role",
            sourceType: "agent_discovered",
          },
          {
            title: "Handle Platform Engineer",
            pageUrl: "https://jobs.example.com/job/2",
            itemContext: "Platform-heavy role",
            sourceType: "agent_discovered",
          },
        ],
      }),
      startGenericBrowserQueueWorkflow: async () => ({
        workflowId: "workflow-site-memory",
        runId: "workflow-run-site-memory",
      }),
      getAgentTaskWorkflowStatus: async () => ({
        status: "completed",
        running: false,
        completed: true,
        result: {
          value: {
            summary:
              "Queued browser workflow finished for 2 items. Completed: 2.",
            metadata: {
              kind: "execute_task_queue",
              workflowName: "GenericBrowserQueueWorkflow",
              queueType: "generic_browser_queue",
              itemCount: 2,
              finalUrl: "https://jobs.example.com/job/2",
              taskSteps: [
                {
                  title: "Handle Backend Engineer",
                  status: "completed",
                  pageUrl: "https://jobs.example.com/job/1",
                  resultSummary: "Opened the backend role and verified it matched the goal.",
                },
                {
                  title: "Handle Platform Engineer",
                  status: "completed",
                  pageUrl: "https://jobs.example.com/job/2",
                  resultSummary: "Opened the platform role and verified it matched the goal.",
                },
              ],
            },
          },
        },
        state: {
          metadata: {
            latestPageUrl: "https://jobs.example.com/job/2",
          },
        },
      }),
    });
    const service1 = new LocalAgentCompanionService(
      store1,
      runtime1 as never,
      createNoopCompanionLogger()
    );
    services.push(service1);

    await service1.startRun({
      userScope: "user:persisted-site-memory",
      goal: "Review the visible jobs and queue the strong matches",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?q=software+engineer",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service1,
      "user:persisted-site-memory",
      "completed"
    );
    const storedRun = await store1.getRun(
      "user:persisted-site-memory",
      String(completed.runs[0]?._id)
    );

    expect(storedRun?.siteMemory).toMatchObject({
      host: "jobs.example.com",
      workflowName: "GenericBrowserQueueWorkflow",
      queueType: "generic_browser_queue",
      itemCount: 2,
      sourceTypes: ["agent_discovered"],
    });
    expect(storedRun?.siteMemory?.exampleItems?.[0]).toMatchObject({
      title: "Handle Backend Engineer",
      sourceType: "agent_discovered",
    });
    expect(storedRun?.siteMemory?.taskPatterns?.[0]).toMatchObject({
      title: "Handle Backend Engineer",
      status: "completed",
    });

  });

  test("reuses persisted structured site memory after a fresh store reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "text-fill-companion-site-memory-reload-"));
    tempDirs.push(dir);
    const store1 = new CompanionStateStore(join(dir, "state.json"));

    await store1.createRun({
      userScope: "user:persisted-site-memory-reload",
      goal: "Review the visible jobs and queue the strong matches",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?q=software+engineer",
      siteMemory: {
        host: "jobs.example.com",
        pagePattern: "jobs.example.com/search",
        workflowName: "GenericBrowserQueueWorkflow",
        queueType: "generic_browser_queue",
        itemCount: 2,
        sourceTypes: ["agent_discovered"],
        exampleItems: [
          {
            title: "Handle Backend Engineer",
            sourceType: "agent_discovered",
            pagePattern: "jobs.example.com/job/:id",
          },
        ],
        taskPatterns: [
          {
            title: "Handle Backend Engineer",
            status: "completed",
            resultSummary: "Opened the backend role and verified it matched the goal.",
          },
        ],
        summary: "Queued browser workflow finished for 2 items. Completed: 2.",
        terminalStatus: "completed",
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 2,
        completedTasks: 2,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 2,
        latestPageUrl: "https://jobs.example.com/job/2",
      },
      tasks: [
        {
          _id: "task_site_reload_1",
          title: "Handle Backend Engineer",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 5_000,
          updatedAt: Date.now() - 4_000,
          completedAt: Date.now() - 4_000,
          pageUrl: "https://jobs.example.com/job/1",
        },
      ],
    }).then((run) =>
      store1.updateRun("user:persisted-site-memory-reload", run._id, {
        status: "completed",
        latestSummary: "Queued browser workflow finished for 2 items. Completed: 2.",
      })
    );

    const store2 = new CompanionStateStore(join(dir, "state.json"));
    const runtime2 = new FakeRuntime();
    const service2 = new LocalAgentCompanionService(
      store2,
      runtime2 as never,
      createNoopCompanionLogger()
    );
    services.push(service2);

    await service2.startRun({
      userScope: "user:persisted-site-memory-reload",
      goal: "Review the next page of jobs",
      platformHint: "general",
      pageUrl: "https://jobs.example.com/search?page=2&q=software+engineer",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completedReloaded = await waitForRunStatus(
      service2,
      "user:persisted-site-memory-reload",
      "completed"
    );

    expect(runtime2.agentTaskCalls).toHaveLength(1);
    expect(runtime2.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Reusable structured memory from similar pages on this site."
    );
    expect(runtime2.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Source types: agent_discovered"
    );
    expect(runtime2.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "Reusable steps:"
    );
    expect(runtime2.agentTaskCalls[0]?.siteExperienceContext).toContain(
      "jobs.example.com/search"
    );
    expect(completedReloaded.runs[0]?.status).toBe("completed");
  });

  test("does not reuse learned memory from a different page family on the same host", async () => {
    const { service, store, runtime } = await createTestService();

    await store.createRun({
      userScope: "user:path-family",
      goal: "Apply to a LinkedIn role",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/jobs/view/100",
      siteMemory: {
        host: "www.linkedin.com",
        pagePattern: "www.linkedin.com/jobs/view/:id",
        workflowName: "GenericBrowserTaskWorkflow",
        summary: "Verified Easy Apply fields before submit.",
        sourceTypes: ["agent_discovered"],
        updatedAt: Date.now(),
      },
      progress: {
        totalTasks: 1,
        completedTasks: 1,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 1,
        latestPageUrl: "https://www.linkedin.com/jobs/view/100",
      },
      tasks: [
        {
          _id: "task_jobs_family",
          title: "Complete Easy Apply",
          status: "completed",
          retryCount: 0,
          createdAt: Date.now() - 5_000,
          updatedAt: Date.now() - 4_000,
          completedAt: Date.now() - 4_000,
          pageUrl: "https://www.linkedin.com/jobs/view/100",
        },
      ],
    }).then((run) =>
      store.updateRun("user:path-family", run._id, {
        status: "completed",
        latestSummary: "Completed the LinkedIn jobs workflow.",
      })
    );

    await service.startRun({
      userScope: "user:path-family",
      goal: "Summarize this LinkedIn profile",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/in/example-person/",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    const completed = await waitForRunStatus(
      service,
      "user:path-family",
      "completed"
    );

    expect(runtime.agentTaskCalls).toHaveLength(1);
    expect(runtime.agentTaskCalls[0]?.siteExperienceContext).toBeUndefined();
    expect(completed.runs[0]?.status).toBe("completed");
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

  test("runs approved LinkedIn task batches through a managed workflow with item progress", async () => {
    let statusCallCount = 0;
    const runtime = new FakeRuntime({
      supportsManagedTaskWorkflows: true,
      startLinkedInConnectBatchWorkflow: async () => ({
        workflowId: "workflow-linkedin-batch",
        runId: "workflow-run-linkedin-batch",
      }),
      getAgentTaskWorkflowStatus: async () => {
        statusCallCount += 1;
        if (statusCallCount === 1) {
          return {
            status: "running",
            running: true,
            completed: false,
            state: {
              metadata: {
                latestPageUrl: "https://www.linkedin.com/in/alice/",
                taskSteps: [
                  {
                    title: "Connect with Alice Recruiter",
                    status: "running",
                    pageUrl: "https://www.linkedin.com/in/alice/",
                    retryCount: 0,
                  },
                  {
                    title: "Connect with Bob Recruiter",
                    status: "pending",
                    pageUrl: "https://www.linkedin.com/in/bob/",
                    retryCount: 0,
                  },
                ],
              },
            },
          };
        }

        return {
          status: "completed",
          running: false,
          completed: true,
          result: {
            value: {
              summary: "LinkedIn connect batch finished for 2 targets. Sent: 1. Skipped: 1.",
              metadata: {
                kind: "execute_task_batch",
                batchType: "linkedin_connect",
                itemCount: 2,
                sent: 1,
                skipped: 1,
                failed: 0,
                finalUrl: "https://www.linkedin.com/in/bob/",
                taskSteps: [
                  {
                    title: "Connect with Alice Recruiter",
                    status: "completed",
                    pageUrl: "https://www.linkedin.com/in/alice/",
                    resultSummary: "Sent the invitation and verified the pending state.",
                    retryCount: 0,
                  },
                  {
                    title: "Connect with Bob Recruiter",
                    status: "skipped",
                    pageUrl: "https://www.linkedin.com/in/bob/",
                    skipReason: "Already connected",
                    resultSummary: "Detected an existing connection and skipped safely.",
                    retryCount: 0,
                  },
                ],
              },
            },
          },
          state: {
            metadata: {
              latestPageUrl: "https://www.linkedin.com/in/bob/",
              taskSteps: [
                {
                  title: "Connect with Alice Recruiter",
                  status: "completed",
                  pageUrl: "https://www.linkedin.com/in/alice/",
                  resultSummary: "Sent the invitation and verified the pending state.",
                  retryCount: 0,
                },
                {
                  title: "Connect with Bob Recruiter",
                  status: "skipped",
                  pageUrl: "https://www.linkedin.com/in/bob/",
                  skipReason: "Already connected",
                  resultSummary: "Detected an existing connection and skipped safely.",
                  retryCount: 0,
                },
              ],
            },
          },
        };
      },
    });
    const { service, store } = await createTestService(runtime);

    const run = await store.createRun({
      userScope: "user:batch-approval",
      goal: "Send approved LinkedIn outreach batch",
      platformHint: "linkedin",
      pageUrl:
        "https://www.linkedin.com/search/results/people/?keywords=software%20recruiter",
    });
    const approval = await store.createApproval({
      userScope: "user:batch-approval",
      runId: run._id,
      approvalKind: "task_batch",
      title: "Send LinkedIn outreach",
      payload: {
        actionType: "create_task_batch",
        batchType: "linkedin_connect",
        dailyLimit: 2,
        items: [
          {
            targetUrl: "https://www.linkedin.com/in/alice/",
            targetName: "Alice Recruiter",
            generatedText: "Hi Alice, I'd love to connect.",
          },
          {
            targetUrl: "https://www.linkedin.com/in/bob/",
            targetName: "Bob Recruiter",
            generatedText: "Hi Bob, I'd love to connect.",
          },
        ],
      },
    });

    const resolved = await service.resolveApproval({
      userScope: "user:batch-approval",
      approvalId: approval._id,
      decision: "approved",
      providerConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-nano",
      },
    });

    expect(resolved).toMatchObject({
      ok: true,
      status: "executing",
      runId: run._id,
    });

    const completed = await waitForRunStatus(
      service,
      "user:batch-approval",
      "completed"
    );

    expect(runtime.batchWorkflowStartCalls).toHaveLength(1);
    expect(runtime.batchCalls).toHaveLength(0);
    expect(completed.runs[0]).toMatchObject({
      status: "completed",
      workflowId: "workflow-linkedin-batch",
      workflowRunId: "workflow-run-linkedin-batch",
      workflowStatus: "completed",
    });
    expect(completed.runs[0]?.progress).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      skippedTasks: 1,
      blockedTasks: 0,
      latestPageUrl: "https://www.linkedin.com/in/bob/",
    });
    expect(completed.runs[0]?.tasks).toMatchObject([
      {
        title: "Connect with Alice Recruiter",
        status: "completed",
      },
      {
        title: "Connect with Bob Recruiter",
        status: "skipped",
        skipReason: "Already connected",
      },
    ]);

    const storedApproval = await waitForApprovalStatus(
      store,
      "user:batch-approval",
      approval._id,
      "completed"
    );
    expect(storedApproval).toMatchObject({
      status: "completed",
    });
    expect(storedApproval?.payload?.actionResult).toMatchObject({
      batchType: "linkedin_connect",
      sent: 1,
      skipped: 1,
      failed: 0,
    });
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
