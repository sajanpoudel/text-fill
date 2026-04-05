import { convexTest } from "convex-test";
import workflowTest from "@convex-dev/workflow/test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS } from "../../convex/agentWorkflows";
import schema from "../../convex/schema";

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  workflowTest.register(t);
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const authed = t.withIdentity({ subject: `${userId}|session` });
  return { t, authed, userId };
}

async function flushDueScheduled(t: Awaited<ReturnType<typeof setup>>["t"]) {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000));
}

async function completePendingNavigationCommand(args: {
  authed: Awaited<ReturnType<typeof setup>>["authed"];
  t: Awaited<ReturnType<typeof setup>>["t"];
  tabId: number;
  pageUrl: string;
}) {
  const pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.tabId,
    pageUrl: args.pageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("navigate");

  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.tabId}`,
    tabId: args.tabId,
    pageUrl: args.pageUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.tabId}`,
    status: "completed",
    result: pending[0].command,
  });

  await flushDueScheduled(args.t);
}

async function completeLinkedInProfileEnrichmentSequence(args: {
  authed: Awaited<ReturnType<typeof setup>>["authed"];
  t: Awaited<ReturnType<typeof setup>>["t"];
  sourceTabId: number;
  sourcePageUrl: string;
  profileTabId: number;
  profileUrl: string;
  profileTitle: string;
  profileHeadline?: string;
  profileSummary?: string;
  expectedOpenUrl?: string;
}) {
  let pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.sourceTabId,
    pageUrl: args.sourcePageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("open_tab");
  if (args.expectedOpenUrl) {
    expect((pending[0].command as { url?: string }).url).toBe(args.expectedOpenUrl);
  }

  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.sourceTabId}`,
    tabId: args.sourceTabId,
    pageUrl: args.sourcePageUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.sourceTabId}`,
    status: "completed",
    result: {
      kind: "open_tab",
      tabId: args.profileTabId,
      url: args.profileUrl,
    },
  });
  await flushDueScheduled(args.t);

  pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("wait_for_tab_complete");
  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    status: "completed",
    result: {
      kind: "wait_for_tab_complete",
      tabId: args.profileTabId,
      status: "complete",
    },
  });
  await flushDueScheduled(args.t);

  pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("wait");
  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    status: "completed",
    result: {
      kind: "wait",
      waitedMs: 800,
    },
  });
  await flushDueScheduled(args.t);

  pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("extract_structured");
  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    status: "completed",
    result: {
      kind: "extract_structured",
      tabId: args.profileTabId,
      scope: "main",
      result: {
        data: {
          title: args.profileTitle,
          headline: args.profileHeadline,
          summary: args.profileSummary,
        },
        matchedFields: ["title", "headline", "summary"],
        unmatchedFields: [],
        headings: [args.profileTitle],
        text: args.profileSummary ?? args.profileHeadline ?? "",
      },
    },
  });
  await flushDueScheduled(args.t);

  pending = await args.authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("close_tab");
  await args.authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    tabId: args.profileTabId,
    pageUrl: args.profileUrl,
  });
  await args.authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${args.profileTabId}`,
    status: "completed",
    result: {
      kind: "close_tab",
      tabId: args.profileTabId,
      closed: true,
    },
  });
  await flushDueScheduled(args.t);
}

async function completeBootstrapObservationPass(args: {
  authed: Awaited<ReturnType<typeof setup>>["authed"];
  t: Awaited<ReturnType<typeof setup>>["t"];
  runId: Id<"agentRuns">;
  tabId: number;
  pageUrl: string;
  title?: string;
  headline?: string;
  summary?: string;
  interactiveElements?: Array<{
    id: string;
    selector: string;
    tag: string;
    role: string | null;
    type: string | null;
    href: string | null;
    label: string | null;
    text: string | null;
    disabled: boolean;
  }>;
}) {
  const { authed, t, tabId, pageUrl } = args;

  let pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId,
    pageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("snapshot_interactives");
  await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    tabId,
    pageUrl,
  });
  await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    status: "completed",
    result: {
      kind: "snapshot_interactives",
      tabId,
      scope: "main",
      elements:
        args.interactiveElements ?? [
          {
            id: "interactive-1",
            selector: "#connect",
            tag: "button",
            role: null,
            type: null,
            href: null,
            label: "Connect",
            text: "Connect",
            disabled: false,
          },
        ],
    },
  });

  await flushDueScheduled(t);

  pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId,
    pageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("get_accessibility_tree");
  await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    tabId,
    pageUrl,
  });
  await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    status: "completed",
    result: {
      kind: "get_accessibility_tree",
      tabId,
      scope: "main",
      tree: {
        tag: "main",
        role: "main",
        label: null,
        text: "Profile page",
        children: [],
      },
    },
  });

  await flushDueScheduled(t);

  pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId,
    pageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("extract_structured");
  await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    tabId,
    pageUrl,
  });
  await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    status: "completed",
    result: {
      kind: "extract_structured",
      tabId,
      scope: "main",
      result: {
        data: {
          title: args.title ?? "Example Recruiter",
          headline: args.headline ?? "Senior Technical Recruiter",
          summary: args.summary ?? "Focused on software engineering hiring.",
        },
        matchedFields: ["title", "headline", "summary"],
        unmatchedFields: [],
        headings: [args.title ?? "Example Recruiter"],
        text: args.summary ?? "Focused on software engineering hiring.",
      },
    },
  });

  await flushDueScheduled(t);
}

async function completeLinkedInCandidateScanPass(args: {
  authed: Awaited<ReturnType<typeof setup>>["authed"];
  t: Awaited<ReturnType<typeof setup>>["t"];
  tabId: number;
  pageUrl: string;
  candidates: Array<{
    targetName: string;
    targetUrl: string;
    headline?: string;
  }>;
  nextPageUrl?: string | null;
}) {
  const { authed, t, tabId, pageUrl } = args;
  const pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
    tabId,
    pageUrl,
  });
  expect((pending[0].command as { kind?: string }).kind).toBe("scan_candidates");

  await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    tabId,
    pageUrl,
  });
  await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
    commandId: pending[0]._id,
    claimedBy: `service-worker:${tabId}`,
    status: "completed",
    result: {
      kind: "scan_candidates",
      tabId,
      platform: "linkedin",
      scan: {
        platform: "linkedin",
        pageType: "people_search",
        candidates: args.candidates,
        nextPageUrl: args.nextPageUrl ?? null,
      },
    },
  });

  await flushDueScheduled(t);
}

describe("agent runs", () => {
  test("createRun seeds a new run and listRuns returns it for the current user", async () => {
    const { authed } = await setup();

    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Find 20 software recruiters and prepare connection requests.",
      platformHint: "linkedin",
    });

    const runs = await authed.query(api.agentRuns.listRuns, {});
    expect(runs).toHaveLength(1);
    expect(runs[0]._id).toBe(runId);
    expect(runs[0].status).toBe("created");
    expect(runs[0].lastSummarizedAtStep).toBe(0);
  });

  test("appendStep advances step index and stores rolling summaries on the run", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Draft outreach notes",
    });

    const first = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "planner",
      content: "Plan the first browser action.",
    });
    const second = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "summary",
      content: "Summarized the first five steps.",
      summaryAfterStep: "Completed discovery and selected the first prospects.",
    });

    expect(first.stepIndex).toBe(1);
    expect(second.stepIndex).toBe(2);

    const details = await authed.query(api.agentRuns.getRun, { runId });
    expect(details?.run.currentStepIndex).toBe(2);
    expect(details?.run.latestSummary).toBe(
      "Completed discovery and selected the first prospects."
    );
    expect(details?.run.lastSummarizedAtStep).toBe(2);
    expect(details?.steps.map((step) => step.stepIndex)).toEqual([1, 2]);
  });

  test("getPlannerContext returns only steps after the last stored summary", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Find recruiters and prepare outreach",
      platformHint: "linkedin",
    });

    await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "system",
      content: "Started the run.",
    });
    await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "browser_result",
      content: "Observed search results.",
    });
    await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "summary",
      content: "Summarized the bootstrap pass.",
      summaryAfterStep: "Completed initial bootstrap observations.",
    });
    await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "planner",
      content: "Prepare the next tactical step.",
    });
    await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "browser_result",
      content: "Found three visible recruiter profiles.",
    });

    const context = await authed.query(internal.agentRuns.getPlannerContext, {
      runId,
      recentStepLimit: 5,
    });

    expect(context.lastSummarizedAtStep).toBe(3);
    expect(context.latestSummary).toBe("Completed initial bootstrap observations.");
    expect(context.recentSteps).toEqual([
      {
        stepIndex: 4,
        role: "planner",
        content: "Prepare the next tactical step.",
      },
      {
        stepIndex: 5,
        role: "browser_result",
        content: "Found three visible recruiter profiles.",
      },
    ]);
  });

  test("browser commands can be queued for a tab, claimed once, and completed", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Open a recruiter profile and wait for the page to settle.",
      platformHint: "linkedin",
    });
    const { stepId } = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "browser_command",
      content: "Open the recruiter profile tab.",
    });

    const { commandId } = await authed.mutation(
      internal.agentRuns.enqueueBrowserCommand,
      {
        runId,
        stepId,
        deliveryScope: "specific_tab",
        targetTabId: 18,
        command: {
          kind: "navigate",
          tabId: 18,
          url: "https://www.linkedin.com/in/example-recruiter",
        },
      }
    );

    const pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
      tabId: 18,
      pageUrl: "https://www.linkedin.com/feed/",
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]._id).toBe(commandId);

    await expect(
      authed.mutation(internal.agentRuns.claimBrowserCommand, {
        commandId,
        claimedBy: "service-worker:18",
      })
    ).resolves.toEqual({ ok: true });

    await expect(
      authed.mutation(internal.agentRuns.claimBrowserCommand, {
        commandId,
        claimedBy: "service-worker:18-second",
      })
    ).resolves.toEqual({ ok: false, status: "claimed" });

    const completion = await authed.mutation(
      internal.agentRuns.completeBrowserCommand,
      {
        commandId,
        status: "completed",
        result: {
          kind: "navigate",
          tabId: 18,
          url: "https://www.linkedin.com/in/example-recruiter",
        },
      }
    );

    expect(completion.alreadyCompleted).toBe(false);

    const runDetails = await authed.query(api.agentRuns.getRun, { runId });
    expect(runDetails?.steps).toHaveLength(1);
    const storedResult = await authed.run((ctx) =>
      ctx.db.get(completion.resultId as Id<"browserCommandResults">)
    );
    expect(storedResult?.status).toBe("completed");
  });

  test("relay claim enforces tab targeting and returns the command payload", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Operate on a specific recruiter tab.",
      platformHint: "linkedin",
    });
    const { stepId } = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "browser_command",
      content: "Wait for the recruiter card button.",
    });

    const { commandId } = await authed.mutation(
      internal.agentRuns.enqueueBrowserCommand,
      {
        runId,
        stepId,
        deliveryScope: "specific_tab",
        targetTabId: 42,
        command: {
          kind: "wait_for_element",
          tabId: 42,
          selector: ".recruiter-card button",
        },
      }
    );

    await expect(
      authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
        commandId,
        claimedBy: "service-worker:42",
        status: "completed",
        result: {
          kind: "wait_for_element",
          tabId: 42,
          selector: ".recruiter-card button",
          found: true,
        },
      })
    ).rejects.toThrow("Browser command must be claimed before completion");

    await expect(
      authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
        commandId,
        claimedBy: "service-worker:41",
        tabId: 41,
        pageUrl: "https://www.linkedin.com/in/example",
      })
    ).rejects.toThrow("Command does not target this tab");

    const claimed = await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
      commandId,
      claimedBy: "service-worker:42",
      tabId: 42,
      pageUrl: "https://www.linkedin.com/in/example",
    });

    expect(claimed).toMatchObject({
      ok: true,
      status: "claimed",
      runId,
      command: {
        kind: "wait_for_element",
        tabId: 42,
        selector: ".recruiter-card button",
      },
    });

    await expect(
      authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
        commandId,
        claimedBy: "service-worker:41",
        status: "completed",
        result: {
          kind: "wait_for_element",
          tabId: 42,
          selector: ".recruiter-card button",
          found: true,
        },
      })
    ).rejects.toThrow("Browser command is claimed by a different executor");
  });

  test("relay completion is idempotent and run-tab sync is owned by the current user", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Track tabs opened by the relay.",
      platformHint: "linkedin",
    });
    const { stepId } = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "browser_command",
      content: "Open a search results tab.",
    });

    const { commandId } = await authed.mutation(
      internal.agentRuns.enqueueBrowserCommand,
      {
        runId,
        stepId,
        deliveryScope: "any_attached_tab",
        command: {
          kind: "open_tab",
          url: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
          active: false,
        },
      }
    );

    await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
      commandId,
      claimedBy: "service-worker:18",
      tabId: 18,
      pageUrl: "https://www.linkedin.com/feed/",
    });

    const firstCompletion = await authed.mutation(
      api.agentRuns.completeBrowserCommandForRelay,
      {
        commandId,
        claimedBy: "service-worker:18",
        status: "completed",
        result: {
          kind: "open_tab",
          tabId: 77,
          url: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
        },
      }
    );

    const secondCompletion = await authed.mutation(
      api.agentRuns.completeBrowserCommandForRelay,
      {
        commandId,
        claimedBy: "service-worker:18",
        status: "completed",
        result: {
          kind: "open_tab",
          tabId: 77,
          url: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
        },
      }
    );

    expect(firstCompletion.alreadyCompleted).toBe(false);
    expect(secondCompletion.alreadyCompleted).toBe(true);

    const sync = await authed.mutation(api.agentRuns.syncRunTabForRelay, {
      runId,
      tabId: 77,
      status: "open",
      url: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
    });
    expect("tabRecordId" in sync).toBe(true);
    if (!("tabRecordId" in sync)) {
      throw new Error("Expected an open-tab sync result");
    }
    expect(sync.tabRecordId).toBeTruthy();

    await authed.mutation(api.agentRuns.syncRunTabForRelay, {
      runId,
      tabId: 77,
      status: "closed",
    });

    const details = await authed.query(api.agentRuns.getRun, { runId });
    expect(details?.tabs).toHaveLength(0);
  });

  test("approvals can be created, listed, resolved, and expired idempotently", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Send an approved connection request.",
      platformHint: "linkedin",
    });
    const { stepId } = await authed.mutation(internal.agentRuns.appendStep, {
      runId,
      role: "approval",
      content: "Await approval to send the message.",
    });

    const { approvalId } = await authed.mutation(
      internal.agentRuns.createApproval,
      {
        runId,
        stepId,
        approvalKind: "connect",
        title: "Send connection request to Example Recruiter",
        reason: "Irreversible action",
        payload: {
          recipientName: "Example Recruiter",
        },
      }
    );

    const pending = await authed.query(api.agentRuns.listPendingApprovals, {});
    expect(pending).toHaveLength(1);
    expect(pending[0]._id).toBe(approvalId);

    const resolved = await authed.mutation(api.agentRuns.resolveApproval, {
      approvalId,
      decision: "approved",
      decisionNote: "Looks good.",
    });
    expect(resolved).toEqual({ ok: true, status: "approved" });

    const expired = await authed.mutation(internal.agentRuns.expireApproval, {
      approvalId,
    });
    expect(expired).toEqual({ ok: true, status: "approved" });
  });

  test("run tabs are upserted and can be closed or orphaned", async () => {
    const { authed } = await setup();
    const { runId } = await authed.mutation(api.agentRuns.createRun, {
      goal: "Track run-owned tabs for recovery.",
    });

    const first = await authed.mutation(internal.agentRuns.registerRunTab, {
      runId,
      tabId: 25,
      url: "https://www.linkedin.com/in/first",
    });
    const second = await authed.mutation(internal.agentRuns.registerRunTab, {
      runId,
      tabId: 25,
      url: "https://www.linkedin.com/in/first/details",
    });

    expect(first.tabRecordId).toBe(second.tabRecordId);

    await authed.mutation(internal.agentRuns.closeRunTab, {
      runId,
      tabId: 25,
      status: "orphaned",
    });

    const details = await authed.query(api.agentRuns.getRun, { runId });
    expect(details?.tabs).toHaveLength(0);
    const storedTab = await authed.run((ctx) =>
      ctx.db.get(first.tabRecordId as Id<"agentRunTabs">)
    );
    expect(storedTab?.status).toBe("orphaned");
    expect(storedTab?.closedAt).toBeTypeOf("number");
  });

  test("startRun launches the bootstrap workflow and completes after command results are reported", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId, workflowId } = await authed.mutation(
        api.agentOrchestration.startRun,
        {
          goal: "Inspect the current page and build bootstrap planner context.",
          platformHint: "linkedin",
          targetTabId: 55,
          pageUrl: "https://www.linkedin.com/in/example-recruiter/",
        }
      );

      await flushDueScheduled(t);

      let details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 20,
      });
      expect(details?.run.activeWorkflowId).toBe(workflowId);
      expect(details?.run.status).toBe("executing");
      expect(details?.tabs[0]?.tabId).toBe(55);

      await completeBootstrapObservationPass({
        authed,
        t,
        runId,
        tabId: 55,
        pageUrl: "https://www.linkedin.com/in/example-recruiter/",
      });

      details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 20,
      });
      expect(details?.run.status).toBe("completed");
      expect(details?.run.latestSummary).toContain("interactive elements");
      expect(
        details?.steps.some(
          (step: (typeof details.steps)[number]) => step.role === "summary"
        )
      ).toBe(true);

      const remaining = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 55,
        pageUrl: "https://www.linkedin.com/in/example-recruiter/",
      });
      expect(remaining).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("connect-oriented planner flow waits for approval and creates an approved deterministic batch after approval", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Connect with this recruiter after review",
        platformHint: "linkedin",
        targetTabId: 81,
        pageUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
      });

      await flushDueScheduled(t);
      await completeBootstrapObservationPass({
        authed,
        t,
        runId,
        tabId: 81,
        pageUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        title: "Carolyn Wilmes Orr",
        headline: "Senior Software Engineering Recruiter",
        summary: "Focused on software engineering hiring.",
      });

      let details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details).not.toBeNull();
      if (!details) {
        throw new Error("Expected run details");
      }
      const runDetails = details;
      expect(runDetails.run.status).toBe("awaiting_approval");
      expect(runDetails.run.latestSummary).toContain("Recent progress:");
      expect(
        runDetails.steps.some(
          (step) =>
            step.role === "summary" &&
            step.content.includes("Recent progress:")
        )
      ).toBe(true);
      expect(
        runDetails.steps.some(
          (step) =>
            step.role === "planner" && step.content.includes("LinkedIn profile connect flow")
        )
      ).toBe(true);

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      expect(approvals[0].title).toContain("Carolyn Wilmes Orr");
      expect((approvals[0].payload as { generatedText?: string }).generatedText).toBeTruthy();

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]._id,
        decision: "approved",
        decisionNote: "Looks good.",
      });

      await flushDueScheduled(t);

      details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details).not.toBeNull();
      if (!details) {
        throw new Error("Expected run details");
      }
      const completedDetails = details;
      expect(completedDetails.run.status).toBe("completed");
      expect(completedDetails.run.latestSummary).toContain("deterministic");
      expect(completedDetails.run.latestSummary).toContain("batch");

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe("approved");
      const batch = await authed.query(api.tasks.getBatch, { batchId: batches[0]._id });
      expect(batch?.items).toHaveLength(1);
      expect(batch?.items[0].generatedText).toBeTruthy();
      expect(batch?.items[0].targetName).toBe("Carolyn Wilmes Orr");
    } finally {
      vi.useRealTimers();
    }
  });

  test("search-result outreach planner flow queues a multi-profile deterministic batch after approval", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Find 3 software engineering recruiters here and queue connection requests",
        platformHint: "linkedin",
        targetTabId: 84,
        pageUrl:
          "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter",
      });

      await flushDueScheduled(t);
      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 84,
        pageUrl:
          "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter",
        candidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          },
          {
            targetName: "Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          },
          {
            targetName: "Jordan Hiring",
            targetUrl: "https://www.linkedin.com/in/jordan-hiring/",
          },
        ],
      });

      await completeLinkedInProfileEnrichmentSequence({
        authed,
        t,
        sourceTabId: 84,
        sourcePageUrl:
          "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter",
        profileTabId: 184,
        profileUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        profileTitle: "Carolyn Wilmes Orr",
        profileHeadline: "Principal Engineering Recruiter",
        profileSummary: "Hiring for platform and backend engineering teams.",
      });

      let details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details?.run.status).toBe("awaiting_approval");
      expect(details?.run.latestSummary).toContain("Recent progress:");

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      expect(approvals[0].title).toContain("3");
      expect((approvals[0].payload as { items?: unknown[] }).items).toHaveLength(3);
      expect(
        (
          approvals[0].payload as {
            items?: Array<{ generatedText?: string }>;
          }
        ).items?.every((item) => !!item.generatedText)
      ).toBe(true);
      expect(
        (
          approvals[0].payload as {
            items?: Array<{ targetName?: string; generatedText?: string }>;
          }
        ).items?.find((item) => item.targetName === "Carolyn Wilmes Orr")?.generatedText
      ).toContain("principal engineering recruiter");

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]._id,
        decision: "approved",
        decisionNote: "Queue the visible profiles.",
      });

      await flushDueScheduled(t);

      details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details?.run.status).toBe("completed");
      expect(details?.run.latestSummary).toContain("3 queued items");

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(1);
      const batch = await authed.query(api.tasks.getBatch, { batchId: batches[0]._id });
      expect(batch?.items).toHaveLength(3);
      expect(batch?.items.map((item) => item.targetName)).toEqual([
        "Carolyn Wilmes Orr",
        "Taylor Recruiter",
        "Jordan Hiring",
      ]);
      expect(batch?.items.every((item) => !!item.generatedText)).toBe(true);
      expect(
        batch?.items.find((item) => item.targetName === "Carolyn Wilmes Orr")
          ?.generatedText
      ).toContain("principal engineering recruiter");
    } finally {
      vi.useRealTimers();
    }
  });

  test("search-result outreach planner uses model-backed drafts when provider settings are configured", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed, userId } = await setup();
      await t.run(async (ctx) => {
        await ctx.db.insert("userProfiles", {
          userId,
          provider: "openai",
          model: "gpt-5-nano",
          openaiKey: "test-openai-key",
        });
      });

      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              drafts: [
                {
                  targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
                  generatedText:
                    "Hi Carolyn, your work recruiting for platform engineering teams stood out to me. I’d love to connect and stay in touch.",
                },
                {
                  targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
                  generatedText:
                    "Hi Taylor, I’m reaching out because your recruiting work in technical hiring caught my eye. I’d love to connect.",
                },
                {
                  targetUrl: "https://www.linkedin.com/in/jordan-hiring/",
                  generatedText:
                    "Hi Jordan, your recruiting background in software hiring stood out to me. I’d love to connect and stay in touch.",
                },
              ],
            }),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
      vi.stubGlobal("fetch", fetchMock);

      const pageUrl =
        "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter";
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Find 3 software engineering recruiters here and queue connection requests",
        platformHint: "linkedin",
        targetTabId: 94,
        pageUrl,
      });

      await flushDueScheduled(t);
      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 94,
        pageUrl,
        candidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            headline: "Principal Engineering Recruiter",
          },
          {
            targetName: "Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
            headline: "Technical Recruiter",
          },
          {
            targetName: "Jordan Hiring",
            targetUrl: "https://www.linkedin.com/in/jordan-hiring/",
            headline: "Software Recruiter",
          },
        ],
      });

      await completeLinkedInProfileEnrichmentSequence({
        authed,
        t,
        sourceTabId: 94,
        sourcePageUrl: pageUrl,
        profileTabId: 294,
        profileUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        profileTitle: "Carolyn Wilmes Orr",
        profileHeadline: "Principal Engineering Recruiter",
        profileSummary: "Hiring for platform and backend engineering teams.",
      });

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      const approvalItems =
        (approvals[0].payload as {
          items?: Array<{ targetName?: string; generatedText?: string }>;
        }).items ?? [];
      expect(approvalItems).toHaveLength(3);
      expect(
        approvalItems.find((item) => item.targetName === "Carolyn Wilmes Orr")
          ?.generatedText
      ).toContain("platform engineering teams");
      expect(
        approvalItems.find((item) => item.targetName === "Taylor Recruiter")
          ?.generatedText
      ).toContain("technical hiring");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const fetchCalls = fetchMock.mock.calls as unknown as Array<
        [RequestInfo | URL, RequestInit | undefined]
      >;
      const requestInit = fetchCalls[0]?.[1];
      const requestBody =
        typeof requestInit?.body === "string"
          ? JSON.parse(requestInit.body)
          : null;
      expect(requestBody?.model).toBe("gpt-5-nano");
      expect(typeof requestBody?.input).toBe("string");
      expect(requestBody?.input).toContain("Carolyn Wilmes Orr");

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 40,
      });
      expect(
        details?.steps.some(
          (step) =>
            step.role === "planner" &&
            step.content.includes("Generated model-backed LinkedIn connection drafts")
        )
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("search-result outreach planner follows the next page when the first page is insufficient", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const startUrl =
        "https://www.linkedin.com/search/results/people/?keywords=software%20recruiter";
      const secondUrl = `${startUrl}&page=2`;

      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Find 4 software recruiters and queue connection requests",
        platformHint: "linkedin",
        targetTabId: 85,
        pageUrl: startUrl,
      });

      await flushDueScheduled(t);
      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 85,
        pageUrl: startUrl,
        candidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          },
          {
            targetName: "Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          },
        ],
        nextPageUrl: secondUrl,
      });

      await completePendingNavigationCommand({
        authed,
        t,
        tabId: 85,
        pageUrl: startUrl,
      });

      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 85,
        pageUrl: secondUrl,
        candidates: [
          {
            targetName: "Jordan Hiring",
            targetUrl: "https://www.linkedin.com/in/jordan-hiring/",
          },
          {
            targetName: "Alex Talent",
            targetUrl: "https://www.linkedin.com/in/alex-talent/",
          },
        ],
      });
      await completeLinkedInProfileEnrichmentSequence({
        authed,
        t,
        sourceTabId: 85,
        sourcePageUrl: secondUrl,
        profileTabId: 203,
        profileUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        profileTitle: "Carolyn Wilmes Orr",
        profileHeadline: "Principal Engineering Recruiter",
        profileSummary: "Leads software engineering recruiting for growth teams.",
      });

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 40,
      });
      expect(details?.run.status).toBe("awaiting_approval");

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      expect((approvals[0].payload as { items?: unknown[] }).items).toHaveLength(4);
      expect(
        (
          approvals[0].payload as {
            items?: Array<{ generatedText?: string }>;
          }
        ).items?.every((item) => !!item.generatedText)
      ).toBe(true);

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]._id,
        decision: "approved",
        decisionNote: "Queue all four.",
      });

      await flushDueScheduled(t);

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(1);
      const batch = await authed.query(api.tasks.getBatch, { batchId: batches[0]._id });
      expect(batch?.items.map((item) => item.targetName)).toEqual([
        "Carolyn Wilmes Orr",
        "Taylor Recruiter",
        "Jordan Hiring",
        "Alex Talent",
      ]);
      expect(batch?.items.every((item) => !!item.generatedText)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("search-result enrichment targets the strongest later-page match, not just the first collected item", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const startUrl =
        "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter";
      const secondUrl = `${startUrl}&page=2`;

      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Find 2 software engineering recruiters and queue connection requests",
        platformHint: "linkedin",
        targetTabId: 88,
        pageUrl: startUrl,
      });

      await flushDueScheduled(t);
      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 88,
        pageUrl: startUrl,
        candidates: [
          {
            targetName: "Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
            headline: "Technical Recruiter",
          },
        ],
        nextPageUrl: secondUrl,
      });

      await completePendingNavigationCommand({
        authed,
        t,
        tabId: 88,
        pageUrl: startUrl,
      });

      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 88,
        pageUrl: secondUrl,
        candidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            headline: "Software Engineering Recruiter",
          },
        ],
      });

      await completeLinkedInProfileEnrichmentSequence({
        authed,
        t,
        sourceTabId: 88,
        sourcePageUrl: secondUrl,
        profileTabId: 288,
        profileUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        expectedOpenUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        profileTitle: "Carolyn Wilmes Orr",
        profileHeadline: "Software Engineering Recruiter",
        profileSummary: "Leads software engineering recruiting for platform teams.",
      });

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      expect((approvals[0].payload as { items?: unknown[] }).items).toHaveLength(2);
      expect(
        (
          approvals[0].payload as {
            items?: Array<{ targetName?: string; generatedText?: string }>;
          }
        ).items?.find((item) => item.targetName === "Carolyn Wilmes Orr")?.generatedText
      ).toContain("software engineering recruiter");

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 40,
      });
      expect(details?.run.status).toBe("awaiting_approval");
    } finally {
      vi.useRealTimers();
    }
  });

  test("search-result outreach planner filters unrelated visible candidates before approval handoff", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const pageUrl =
        "https://www.linkedin.com/search/results/people/?keywords=software%20engineering%20recruiter";

      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Find 3 software engineering recruiters and queue connection requests",
        platformHint: "linkedin",
        targetTabId: 91,
        pageUrl,
      });

      await flushDueScheduled(t);
      await completeLinkedInCandidateScanPass({
        authed,
        t,
        tabId: 91,
        pageUrl,
        candidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            headline: "Principal Engineering Recruiter",
          },
          {
            targetName: "Sam Sales",
            targetUrl: "https://www.linkedin.com/in/sam-sales/",
            headline: "Enterprise Sales Recruiter",
          },
          {
            targetName: "Pat Engineer",
            targetUrl: "https://www.linkedin.com/in/pat-engineer/",
            headline: "Senior Software Engineer",
          },
        ],
      });
      await completeLinkedInProfileEnrichmentSequence({
        authed,
        t,
        sourceTabId: 91,
        sourcePageUrl: pageUrl,
        profileTabId: 209,
        profileUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        profileTitle: "Carolyn Wilmes Orr",
        profileHeadline: "Principal Engineering Recruiter",
        profileSummary: "Leads hiring for platform and backend engineering teams.",
      });

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 40,
      });
      expect(details?.run.status).toBe("awaiting_approval");

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);
      expect((approvals[0].payload as { items?: unknown[] }).items).toHaveLength(1);
      const approvalItem = (
        approvals[0].payload as {
          items?: Array<{ targetName?: string; generatedText?: string }>;
        }
      ).items?.[0];
      expect(approvalItem?.targetName).toBe("Carolyn Wilmes Orr");
      expect(approvalItem?.generatedText?.toLowerCase()).toContain(
        "principal engineering recruiter"
      );

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]._id,
        decision: "approved",
        decisionNote: "Queue the matching recruiter only.",
      });

      await flushDueScheduled(t);

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(1);
      const batch = await authed.query(api.tasks.getBatch, { batchId: batches[0]._id });
      expect(batch?.items).toHaveLength(1);
      expect(batch?.items[0]?.targetName).toBe("Carolyn Wilmes Orr");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejected planner approval pauses the run and does not create a deterministic batch", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Connect with this recruiter after review",
        platformHint: "linkedin",
        targetTabId: 82,
        pageUrl: "https://www.linkedin.com/in/reject-me/",
      });

      await flushDueScheduled(t);
      await completeBootstrapObservationPass({
        authed,
        t,
        runId,
        tabId: 82,
        pageUrl: "https://www.linkedin.com/in/reject-me/",
        title: "Reject Me",
        headline: "Engineering Recruiter",
      });

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]._id,
        decision: "rejected",
        decisionNote: "Do not queue it.",
      });

      await flushDueScheduled(t);

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details).not.toBeNull();
      if (!details) {
        throw new Error("Expected run details");
      }
      const pausedDetails = details;
      expect(pausedDetails.run.status).toBe("paused");
      expect(pausedDetails.run.lastError).toContain("rejected");

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("expired planner approval pauses the run after the scheduled expiry fires", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Connect with this recruiter after review",
        platformHint: "linkedin",
        targetTabId: 83,
        pageUrl: "https://www.linkedin.com/in/expire-me/",
      });

      await flushDueScheduled(t);
      await completeBootstrapObservationPass({
        authed,
        t,
        runId,
        tabId: 83,
        pageUrl: "https://www.linkedin.com/in/expire-me/",
        title: "Expire Me",
        headline: "Engineering Recruiter",
      });

      let approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(1);

      await t.finishAllScheduledFunctions(() =>
        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1)
      );

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details?.run.status).toBe("paused");
      expect(details?.run.lastError).toContain("expired");

      approvals = await authed.query(api.agentRuns.listPendingApprovals, {});
      expect(approvals).toHaveLength(0);

      const batches = await authed.query(api.tasks.getPendingBatches, {});
      expect(batches).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancelRun cancels the workflow and drains queued commands", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Inspect the page then stop immediately.",
        platformHint: "linkedin",
        targetTabId: 91,
        pageUrl: "https://www.linkedin.com/in/cancel-me/",
      });

      await flushDueScheduled(t);

      let pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 91,
        pageUrl: "https://www.linkedin.com/in/cancel-me/",
      });
      expect(pending).toHaveLength(1);

      await authed.mutation(api.agentRuns.cancelRun, { runId });
      await flushDueScheduled(t);

      const details = await authed.query(api.agentRuns.getRun, { runId, stepLimit: 20 });
      expect(details?.run.status).toBe("cancelled");

      pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 91,
        pageUrl: "https://www.linkedin.com/in/cancel-me/",
      });
      expect(pending).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bootstrap workflow fails the run when a browser command times out", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed } = await setup();
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Inspect the current page and capture initial context.",
        platformHint: "linkedin",
        targetTabId: 66,
        pageUrl: "https://www.linkedin.com/in/timeout-case/",
      });

      await flushDueScheduled(t);

      let pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 66,
        pageUrl: "https://www.linkedin.com/in/timeout-case/",
      });
      expect(pending).toHaveLength(1);
      expect((pending[0].command as { kind?: string }).kind).toBe("snapshot_interactives");

      await t.finishAllScheduledFunctions(() =>
        vi.advanceTimersByTime(BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS + 1)
      );

      const details = await authed.query(api.agentRuns.getRun, { runId, stepLimit: 20 });
      expect(details?.run.status).toBe("failed");
      expect(details?.run.lastError).toContain("Timed out");

      pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 66,
        pageUrl: "https://www.linkedin.com/in/timeout-case/",
      });
      expect(pending).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("conversation draft runs create an approval and insert the approved draft into the captured field", async () => {
    vi.useFakeTimers();
    try {
      const { t, authed, userId } = await setup();
      await t.run(async (ctx) => {
        await ctx.db.insert("userProfiles", {
          userId,
          provider: "openai",
          model: "gpt-5-nano",
          openaiKey: "test-openai-key",
        });
      });

      const generatedDraft =
        "Hi Taylor,\n\nThanks for following up here. I’d be glad to stay in touch about backend engineering hiring.";
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: generatedDraft,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
      vi.stubGlobal("fetch", fetchMock);

      const pageUrl = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQexample";
      const { runId } = await authed.mutation(api.agentOrchestration.startRun, {
        goal: "Draft a thoughtful reply for this thread and wait for approval",
        platformHint: "gmail",
        targetTabId: 55,
        pageUrl,
        pageContext:
          "Field: [EMAIL_BODY]\nAudience: Taylor Recruiter\nThread context:\nFollowing up on backend engineering hiring for next quarter.",
        fieldTarget: {
          selector: "#composer",
          platform: "gmail",
          fieldType: "[EMAIL_BODY]",
          charLimit: 1200,
        },
      });

      await flushDueScheduled(t);

      const approvals = await authed.query(api.agentRuns.listPendingApprovals, {
        limit: 5,
      });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.title).toContain("Taylor Recruiter");
      expect(approvals[0]?.payload).toMatchObject({
        actionType: "insert_draft",
        generatedText: generatedDraft,
      });

      await authed.mutation(api.agentRuns.resolveApproval, {
        approvalId: approvals[0]!._id as Id<"agentApprovals">,
        decision: "approved",
      });
      await flushDueScheduled(t);

      let pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 55,
        pageUrl,
      });
      expect((pending[0]?.command as { kind?: string } | undefined)?.kind).toBe(
        "insert_text"
      );

      await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
        commandId: pending[0]!._id,
        claimedBy: "service-worker:55",
        tabId: 55,
        pageUrl,
      });
      await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
        commandId: pending[0]!._id,
        claimedBy: "service-worker:55",
        status: "completed",
        result: {
          kind: "insert_text",
          tabId: 55,
          selector: "#composer",
          inserted: true,
        },
      });
      await flushDueScheduled(t);

      pending = await authed.query(api.agentRuns.listPendingCommandsForTab, {
        tabId: 55,
        pageUrl,
      });
      expect((pending[0]?.command as { kind?: string } | undefined)?.kind).toBe(
        "verify_text"
      );

      await authed.mutation(api.agentRuns.claimBrowserCommandForRelay, {
        commandId: pending[0]!._id,
        claimedBy: "service-worker:55",
        tabId: 55,
        pageUrl,
      });
      await authed.mutation(api.agentRuns.completeBrowserCommandForRelay, {
        commandId: pending[0]!._id,
        claimedBy: "service-worker:55",
        status: "completed",
        result: {
          kind: "verify_text",
          tabId: 55,
          expectedText: "Hi Taylor, Thanks for following up here.",
          matched: true,
          text: generatedDraft,
        },
      });
      await flushDueScheduled(t);

      const details = await authed.query(api.agentRuns.getRun, {
        runId,
        stepLimit: 30,
      });
      expect(details?.run.status).toBe("completed");
      expect(details?.run.latestSummary).toContain("approved draft");
    } finally {
      vi.useRealTimers();
    }
  });
});
