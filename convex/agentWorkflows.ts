import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type {
  BrowserObservationScope,
  InteractiveElementSnapshot,
} from "../src/lib/browser-observation";
import type { CandidateScanItem } from "../src/lib/candidate-scan.ts";
import {
  buildDraftVerificationText,
  deriveConversationDraftDecision,
  enrichLinkedInSearchBatchItems,
  isLinkedInConnectIntent,
  parseRequestedConnectCount,
  rankLinkedInPlannerBatchItemsForEnrichment,
  isLinkedInSearchResultsContext,
  shouldUseConversationDraftFlow,
  type LinkedInProfileObservation,
  type PlannerBatchItem,
  type PlannerDecision,
  shouldCheckpointPlannerSummary,
} from "../src/lib/agent-planner";
import {
  agentFieldTargetValidator,
  approvalDecisionEventValidator,
  browserCommandCompletionEventValidator,
} from "./agentRunValidators";
import { workflow } from "./workflow";

type AgentFieldTarget = {
  selector: string;
  platform?: string;
  fieldType?: string;
  charLimit?: number;
};

type BootstrapCommand = {
  content: string;
  command:
    | {
        kind: "snapshot_interactives";
        tabId: number;
        scope: BrowserObservationScope;
      }
    | {
        kind: "get_accessibility_tree";
        tabId: number;
        scope: BrowserObservationScope;
      }
    | {
        kind: "extract_structured";
        tabId: number;
        scope: BrowserObservationScope;
        schema: string;
        promptHint: string;
      };
};

export const BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const PLANNER_SUMMARY_STEP_INTERVAL = 5;
export const MAX_LINKEDIN_SEARCH_COLLECTION_PASSES = 3;
export const MAX_LINKEDIN_PROFILE_ENRICHMENTS = 1;
export const LINKEDIN_PROFILE_HYDRATION_WAIT_MS = 800;

type StructuredExtractionResult = {
  data?: Record<string, unknown>;
  matchedFields?: string[];
  unmatchedFields?: string[];
  headings?: string[];
  text?: string;
};

type LinkedInCandidateScanPassResult = {
  resultSummary: string;
  scannedCandidates: CandidateScanItem[];
  nextPageUrl: string | null;
};

type QueuedBrowserCommandResult = {
  completion: {
    commandId: Id<"browserCommands">;
    resultId: Id<"browserCommandResults">;
    status: "completed" | "failed";
  };
  resultDoc: Doc<"browserCommandResults"> | null;
};

type PlannerApprovalTarget =
  | { label: string; itemCount: number }
  | { label: string; itemCount: 1 };

function getPlannerApprovalTarget(
  decision: Extract<PlannerDecision, { kind: "request_approval" }>
): PlannerApprovalTarget {
  if (decision.payload.actionType === "insert_draft") {
    return {
      label: decision.payload.targetName ?? "the current compose field",
      itemCount: 1,
    };
  }

  const items = decision.payload.items;
  if (items.length > 1) {
    const previewNames = items
      .map((item) => item.targetName?.trim())
      .filter((name): name is string => Boolean(name))
      .slice(0, 3);
    const extraCount = Math.max(0, items.length - previewNames.length);
    return {
      label:
        previewNames.length > 0
          ? `${previewNames.join(", ")}${extraCount > 0 ? ` +${extraCount} more` : ""}`
          : `${items.length} visible LinkedIn profiles`,
      itemCount: items.length,
    };
  }
  return {
    label: items[0]?.targetName ?? "this LinkedIn profile",
    itemCount: 1,
  };
}

function getBatchItemsFromDecision(
  decision: Extract<PlannerDecision, { kind: "request_approval" }>
) {
  if (decision.payload.actionType !== "create_task_batch") {
    throw new Error("Draft-insert approvals do not create deterministic task batches");
  }
  return decision.payload.items.map((item) => ({
    targetUrl: item.targetUrl,
    targetName: item.targetName,
    ...(item.generatedText ? { generatedText: item.generatedText } : {}),
  }));
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

async function maybeAppendRollingSummary(
  step: any,
  runId: Id<"agentRuns">
) {
  const plannerContext = await step.runQuery(
    internal.agentRuns.getPlannerContext,
    {
      runId,
      recentStepLimit: PLANNER_SUMMARY_STEP_INTERVAL,
    },
    { inline: true, name: "load planner context for summary" }
  );

  if (
    !shouldCheckpointPlannerSummary({
      currentStepIndex: plannerContext.currentStepIndex,
      lastSummarizedAtStep: plannerContext.lastSummarizedAtStep,
      interval: PLANNER_SUMMARY_STEP_INTERVAL,
    })
  ) {
    return null;
  }

  if (plannerContext.recentSteps.length < PLANNER_SUMMARY_STEP_INTERVAL) {
    return null;
  }

  const summaryResult = await step.runAction(
    internal.agentPlanner.summarizeRunProgress,
    {
      goal: plannerContext.goal,
      platformHint: plannerContext.platformHint,
      latestSummary: plannerContext.latestSummary,
      recentSteps: plannerContext.recentSteps,
    },
    { name: "summarize planner progress" }
  );

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId,
      role: "summary",
      content: summaryResult.summary,
      summaryAfterStep: summaryResult.summary,
    },
    { inline: true, name: "append rolling planner summary" }
  );

  return summaryResult.summary;
}

function summarizeBrowserResult(
  command: BootstrapCommand["command"],
  resultDoc: Doc<"browserCommandResults"> | null
): string {
  if (!resultDoc) {
    return `Command ${command.kind} completed without a stored result document.`;
  }

  if (resultDoc.status === "failed") {
    return `Command ${command.kind} failed: ${resultDoc.errorMessage ?? "unknown error"}`;
  }

  if (command.kind === "snapshot_interactives") {
    const elements =
      (resultDoc.result as { elements?: Array<unknown> } | undefined)?.elements ?? [];
    return `Observed ${elements.length} interactive elements on the current page (${command.scope} scan).`;
  }

  if (command.kind === "get_accessibility_tree") {
    const tree =
      (resultDoc.result as { tree?: { tag?: string; children?: Array<unknown> } | null } | undefined)
        ?.tree ?? null;
    const childCount = Array.isArray(tree?.children) ? tree.children.length : 0;
    return `Captured accessibility tree rooted at ${tree?.tag ?? "unknown"} with ${childCount} direct children (${command.scope} scan).`;
  }

  if (command.kind === "extract_structured") {
    const projected =
      (resultDoc.result as {
        result?: {
          matchedFields?: string[];
          unmatchedFields?: string[];
          text?: string;
        };
      } | undefined)?.result;
    const matched = projected?.matchedFields?.length ?? 0;
    const unmatched = projected?.unmatchedFields?.length ?? 0;
    const text = truncate(projected?.text ?? "", 160);
    return `Extracted structured page context (${matched} matched, ${unmatched} unmatched fields, ${command.scope} scan). ${text}`.trim();
  }

  throw new Error("Unsupported bootstrap command");
}

function buildBootstrapCommands(
  targetTabId: number,
  scope: BrowserObservationScope
): BootstrapCommand[] {
  return [
    {
      content: "Snapshot the visible interactive elements for the current page.",
      command: {
        kind: "snapshot_interactives",
        tabId: targetTabId,
        scope,
      },
    },
    {
      content: "Capture the accessibility tree for the main page region.",
      command: {
        kind: "get_accessibility_tree",
        tabId: targetTabId,
        scope,
      },
    },
    {
      content: "Extract bootstrap structured context for the planner.",
      command: {
        kind: "extract_structured",
        tabId: targetTabId,
        scope,
        schema: JSON.stringify({
          type: "object",
          properties: {
            title: { type: "string" },
            headline: { type: "string" },
            summary: { type: "string" },
          },
        }),
        promptHint:
          "Capture the main title/headline/summary so the planner has initial page grounding.",
      },
    },
  ];
}

async function maybeAppendRollingPlannerSummary(step: Parameters<typeof workflow.define>[0]["handler"] extends (step: infer T, ...args: any[]) => any ? T : never, args: {
  runId: Id<"agentRuns">;
  goal: string;
}) {
  const plannerContext = await step.runQuery(
    internal.agentRuns.getPlannerContext,
    {
      runId: args.runId,
      recentStepLimit: 5,
    },
    { inline: true, name: "get planner context" }
  );

  if (
    !shouldCheckpointPlannerSummary({
      currentStepIndex: plannerContext.currentStepIndex,
      lastSummarizedAtStep: plannerContext.lastSummarizedAtStep,
      interval: 5,
    })
  ) {
    return null;
  }

  const summaryResult = await step.runAction(
    internal.agentPlanner.summarizeRunProgress,
    {
      goal: args.goal,
      platformHint: plannerContext.platformHint,
      latestSummary: plannerContext.latestSummary,
      recentSteps: plannerContext.recentSteps,
    },
    { name: "summarize planner progress" }
  );

  const summary = summaryResult.summary.trim();
  if (!summary) return null;

  return step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "summary",
      content: summary,
      summaryAfterStep: summary,
    },
    { inline: true, name: "append rolling planner summary" }
  );
}

type BootstrapObservationPassResult = {
  resultSummaries: string[];
  interactiveSummary?: string;
  accessibilitySummary?: string;
  interactiveElements?: InteractiveElementSnapshot[];
  structuredResult?: StructuredExtractionResult;
};

function isEmptyBootstrapObservation(
  observation: BootstrapObservationPassResult
): boolean {
  const interactiveCount = observation.interactiveElements?.length ?? 0;
  const structuredText = observation.structuredResult?.text?.trim() ?? "";
  const matchedFields = observation.structuredResult?.matchedFields?.length ?? 0;
  return (
    interactiveCount === 0 &&
    matchedFields === 0 &&
    structuredText.length === 0
  );
}

async function runBootstrapObservationPass(step: any, args: {
  runId: Id<"agentRuns">;
  targetTabId: number;
}): Promise<BootstrapObservationPassResult | null> {
  const runSingleBootstrapPass = async (
    scope: BrowserObservationScope
  ): Promise<BootstrapObservationPassResult | null> => {
    const resultSummaries: string[] = [];
    let interactiveSummary: string | undefined;
    let accessibilitySummary: string | undefined;
    let interactiveElements: InteractiveElementSnapshot[] | undefined;
    let structuredResult: StructuredExtractionResult | undefined;

    for (const bootstrap of buildBootstrapCommands(args.targetTabId, scope)) {
      const stepEntry = await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "browser_command",
          content: bootstrap.content,
          toolCall: bootstrap.command,
        },
        { inline: true, name: `append ${bootstrap.command.kind} step` }
      );

      const completionEventId = await workflow.createEvent(step, {
        name: `browser-command:${bootstrap.command.kind}`,
        workflowId: step.workflowId,
      });

      const commandEntry = await step.runMutation(
        internal.agentRuns.enqueueBrowserCommand,
        {
          runId: args.runId,
          stepId: stepEntry.stepId as Id<"agentRunSteps">,
          deliveryScope: "specific_tab",
          targetTabId: args.targetTabId,
          command: bootstrap.command,
          completionEventId: completionEventId as string,
        },
        { inline: true, name: `enqueue ${bootstrap.command.kind}` }
      );

      await step.runMutation(
        internal.agentRuns.scheduleBrowserCommandTimeout,
        {
          commandId: commandEntry.commandId as Id<"browserCommands">,
          timeoutMs: BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS,
        },
        { inline: true, name: `schedule ${bootstrap.command.kind} timeout` }
      );

      const completion = await step.awaitEvent({
        id: completionEventId,
        validator: browserCommandCompletionEventValidator,
      });

      const resultDoc = await step.runQuery(
        internal.agentRuns.getBrowserCommandResultForWorkflow,
        {
          commandId: commandEntry.commandId as Id<"browserCommands">,
        },
        { inline: true, name: `read ${bootstrap.command.kind} result` }
      );

      const summary = summarizeBrowserResult(bootstrap.command, resultDoc);
      resultSummaries.push(summary);
      if (bootstrap.command.kind === "snapshot_interactives") {
        interactiveSummary = summary;
        interactiveElements =
          (resultDoc?.result as { elements?: InteractiveElementSnapshot[] } | undefined)
            ?.elements ?? undefined;
      } else if (bootstrap.command.kind === "get_accessibility_tree") {
        accessibilitySummary = summary;
      } else if (bootstrap.command.kind === "extract_structured") {
        structuredResult =
          (resultDoc?.result as { result?: StructuredExtractionResult } | undefined)
            ?.result ?? undefined;
      }

      await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "browser_result",
          content: summary,
          commandId: completion.commandId,
          toolCall: resultDoc?.result,
        },
        { inline: true, name: `append ${bootstrap.command.kind} result` }
      );
      await maybeAppendRollingSummary(step, args.runId);

      if (completion.status === "failed") {
        await step.runMutation(
          internal.agentRuns.setRunStatus,
          {
            runId: args.runId,
            status: "failed",
            lastError: resultDoc?.errorMessage ?? `${bootstrap.command.kind} failed`,
          },
          { inline: true, name: `fail after ${bootstrap.command.kind}` }
        );
        return null;
      }
    }

    return {
      resultSummaries,
      interactiveSummary,
      accessibilitySummary,
      interactiveElements,
      structuredResult,
    };
  };

  const mainObservation = await runSingleBootstrapPass("main");
  if (!mainObservation) {
    return null;
  }
  if (!isEmptyBootstrapObservation(mainObservation)) {
    return mainObservation;
  }

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "system",
      content:
        "Main-region bootstrap observation was empty, retrying with a top-down full-page scan.",
    },
    { inline: true, name: "append bootstrap viewport fallback" }
  );

  const viewportObservation = await runSingleBootstrapPass("viewport");
  if (!viewportObservation) {
    return null;
  }

  return {
    resultSummaries: [
      ...mainObservation.resultSummaries,
      ...viewportObservation.resultSummaries,
    ],
    interactiveSummary: viewportObservation.interactiveSummary ?? mainObservation.interactiveSummary,
    accessibilitySummary:
      viewportObservation.accessibilitySummary ?? mainObservation.accessibilitySummary,
    interactiveElements:
      viewportObservation.interactiveElements ?? mainObservation.interactiveElements,
    structuredResult:
      viewportObservation.structuredResult ?? mainObservation.structuredResult,
  };
}

async function runLinkedInCandidateScanPass(step: any, args: {
  runId: Id<"agentRuns">;
  targetTabId: number;
  maxResults: number;
}): Promise<LinkedInCandidateScanPassResult | null> {
  const stepEntry = await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "browser_command",
      content:
        "Scan the visible LinkedIn people-search page for connectable candidates and pagination state.",
      toolCall: {
        kind: "scan_candidates",
        tabId: args.targetTabId,
        platform: "linkedin",
        maxResults: args.maxResults,
      },
    },
    { inline: true, name: "append linkedin candidate scan step" }
  );

  const completionEventId = await workflow.createEvent(step, {
    name: "browser-command:scan-candidates",
    workflowId: step.workflowId,
  });

  const commandEntry = await step.runMutation(
    internal.agentRuns.enqueueBrowserCommand,
    {
      runId: args.runId,
      stepId: stepEntry.stepId as Id<"agentRunSteps">,
      deliveryScope: "specific_tab",
      targetTabId: args.targetTabId,
      command: {
        kind: "scan_candidates",
        tabId: args.targetTabId,
        platform: "linkedin",
        maxResults: args.maxResults,
      },
      completionEventId: completionEventId as string,
    },
    { inline: true, name: "enqueue linkedin candidate scan" }
  );

  await step.runMutation(
    internal.agentRuns.scheduleBrowserCommandTimeout,
    {
      commandId: commandEntry.commandId as Id<"browserCommands">,
      timeoutMs: BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS,
    },
    { inline: true, name: "schedule linkedin candidate scan timeout" }
  );

  const completion = await step.awaitEvent({
    id: completionEventId,
    validator: browserCommandCompletionEventValidator,
  });

  const resultDoc = await step.runQuery(
    internal.agentRuns.getBrowserCommandResultForWorkflow,
    {
      commandId: commandEntry.commandId as Id<"browserCommands">,
    },
    { inline: true, name: "read linkedin candidate scan result" }
  );

  const scan =
    (resultDoc?.result as {
      scan?: {
        candidates?: CandidateScanItem[];
        nextPageUrl?: string | null;
        diagnostics?: {
          totalCards?: number;
          totalProfileLinks?: number;
          cardsWithConnectSignal?: number;
        };
      };
    } | undefined)?.scan ?? null;
  const scannedCandidates = Array.isArray(scan?.candidates)
    ? scan.candidates
    : [];
  const nextPageUrl =
    typeof scan?.nextPageUrl === "string" ? scan.nextPageUrl : null;
  const diagnostics = scan?.diagnostics;

  const resultSummary =
    completion.status === "completed"
      ? `Scanned the current LinkedIn people-search page and found ${scannedCandidates.length} connectable candidate${scannedCandidates.length === 1 ? "" : "s"}${diagnostics ? ` from ${diagnostics.totalCards ?? 0} cards, ${diagnostics.totalProfileLinks ?? 0} profile links, and ${diagnostics.cardsWithConnectSignal ?? 0} inline connect signals` : ""}${nextPageUrl ? "; a next page is available." : "."}`
      : `Failed to scan the current LinkedIn people-search page: ${resultDoc?.errorMessage ?? "unknown error"}`;

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "browser_result",
      content: resultSummary,
      commandId: completion.commandId,
      toolCall: resultDoc?.result,
    },
    { inline: true, name: "append linkedin candidate scan result" }
  );
  await maybeAppendRollingSummary(step, args.runId);

  if (completion.status === "failed") {
    await step.runMutation(
      internal.agentRuns.setRunStatus,
      {
        runId: args.runId,
        status: "failed",
        lastError:
          resultDoc?.errorMessage ??
          "Failed to scan the current LinkedIn people-search page",
      },
      { inline: true, name: "fail after linkedin candidate scan" }
    );
    return null;
  }

  return {
    resultSummary,
    scannedCandidates,
    nextPageUrl,
  };
}

async function runQueuedBrowserCommand(step: any, args: {
  runId: Id<"agentRuns">;
  content: string;
  eventName: string;
  command: Record<string, unknown>;
  deliveryScope: "specific_tab" | "any_attached_tab";
  targetTabId?: number;
  targetUrl?: string;
  timeoutMs?: number;
  summarize: (resultDoc: Doc<"browserCommandResults"> | null, status: "completed" | "failed") => string;
}) : Promise<QueuedBrowserCommandResult> {
  const stepEntry = await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "browser_command",
      content: args.content,
      toolCall: args.command,
    },
    { inline: true, name: `append ${args.eventName} step` }
  );

  const completionEventId = await workflow.createEvent(step, {
    name: args.eventName,
    workflowId: step.workflowId,
  });

  const commandEntry = await step.runMutation(
    internal.agentRuns.enqueueBrowserCommand,
    {
      runId: args.runId,
      stepId: stepEntry.stepId as Id<"agentRunSteps">,
      deliveryScope: args.deliveryScope,
      targetTabId: args.targetTabId,
      targetUrl: args.targetUrl,
      command: args.command,
      completionEventId: completionEventId as string,
    },
    { inline: true, name: `enqueue ${args.eventName}` }
  );

  await step.runMutation(
    internal.agentRuns.scheduleBrowserCommandTimeout,
    {
      commandId: commandEntry.commandId as Id<"browserCommands">,
      timeoutMs: args.timeoutMs ?? BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS,
    },
    { inline: true, name: `schedule ${args.eventName} timeout` }
  );

  const completion = await step.awaitEvent({
    id: completionEventId,
    validator: browserCommandCompletionEventValidator,
  });

  const resultDoc = await step.runQuery(
    internal.agentRuns.getBrowserCommandResultForWorkflow,
    {
      commandId: commandEntry.commandId as Id<"browserCommands">,
    },
    { inline: true, name: `read ${args.eventName} result` }
  );

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "browser_result",
      content: args.summarize(resultDoc, completion.status),
      commandId: completion.commandId,
      toolCall: resultDoc?.result,
    },
    { inline: true, name: `append ${args.eventName} result` }
  );
  await maybeAppendRollingSummary(step, args.runId);

  return {
    completion,
    resultDoc,
  };
}

function parseStructuredProfileObservation(
  targetUrl: string,
  resultDoc: Doc<"browserCommandResults"> | null
): LinkedInProfileObservation | null {
  const projected =
    (resultDoc?.result as {
      result?: {
        data?: Record<string, unknown>;
        text?: string;
      };
    } | undefined)?.result;

  const data = projected?.data ?? {};
  const targetName =
    typeof data.title === "string" ? data.title : null;
  const headline =
    typeof data.headline === "string" ? data.headline : null;
  const summary =
    typeof data.summary === "string"
      ? data.summary
      : typeof projected?.text === "string"
        ? projected.text
        : null;

  if (!targetName && !headline && !summary) {
    return null;
  }

  return {
    targetUrl,
    targetName,
    headline,
    summary,
  };
}

async function enrichLinkedInSearchItemsWithProfileContext(step: any, args: {
  runId: Id<"agentRuns">;
  goal: string;
  items: PlannerBatchItem[];
}): Promise<PlannerBatchItem[]> {
  const profileObservations: LinkedInProfileObservation[] = [];

  const rankedItems = rankLinkedInPlannerBatchItemsForEnrichment({
    goal: args.goal,
    items: args.items,
  });

  for (const item of rankedItems.slice(0, MAX_LINKEDIN_PROFILE_ENRICHMENTS)) {
    let profileTabId: number | null = null;

    try {
      const openTabResult = await runQueuedBrowserCommand(step, {
        runId: args.runId,
        content: `Open ${item.targetName}'s LinkedIn profile in a background tab for note enrichment.`,
        eventName: "browser-command:open-profile-enrichment",
        deliveryScope: "any_attached_tab",
        command: {
          kind: "open_tab",
          url: item.targetUrl,
          active: false,
        },
        summarize: (resultDoc, status) => {
          if (status === "failed") {
            return `Failed to open ${item.targetName}'s LinkedIn profile for note enrichment: ${resultDoc?.errorMessage ?? "unknown error"}`;
          }
          const openedUrl =
            (resultDoc?.result as { url?: string } | undefined)?.url ?? item.targetUrl;
          return `Opened ${item.targetName}'s LinkedIn profile in a background tab (${openedUrl}).`;
        },
      });
      if (openTabResult.completion.status === "failed") {
        continue;
      }

      profileTabId =
        (openTabResult.resultDoc?.result as { tabId?: number } | undefined)?.tabId ?? null;
      if (typeof profileTabId !== "number") {
        continue;
      }

      const waitForCompleteResult = await runQueuedBrowserCommand(step, {
        runId: args.runId,
        content: `Wait for ${item.targetName}'s LinkedIn profile tab to finish loading.`,
        eventName: "browser-command:wait-profile-enrichment-tab",
        deliveryScope: "specific_tab",
        targetTabId: profileTabId,
        command: {
          kind: "wait_for_tab_complete",
          tabId: profileTabId,
          timeoutMs: BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS,
        },
        summarize: (resultDoc, status) =>
          status === "failed"
            ? `Timed out waiting for ${item.targetName}'s LinkedIn profile tab to load: ${resultDoc?.errorMessage ?? "unknown error"}`
            : `Loaded ${item.targetName}'s LinkedIn profile tab for note enrichment.`,
      });
      if (waitForCompleteResult.completion.status === "failed") {
        continue;
      }

      const hydrationWaitResult = await runQueuedBrowserCommand(step, {
        runId: args.runId,
        content: `Wait briefly for LinkedIn profile hydration before extracting ${item.targetName}'s context.`,
        eventName: "browser-command:wait-profile-hydration",
        deliveryScope: "specific_tab",
        targetTabId: profileTabId,
        command: {
          kind: "wait",
          durationMs: LINKEDIN_PROFILE_HYDRATION_WAIT_MS,
        },
        summarize: (_resultDoc, status) =>
          status === "failed"
            ? `Failed during the LinkedIn profile hydration wait for ${item.targetName}.`
            : `Waited for LinkedIn profile hydration before extracting ${item.targetName}'s context.`,
      });
      if (hydrationWaitResult.completion.status === "failed") {
        continue;
      }

      const extractResult = await runQueuedBrowserCommand(step, {
        runId: args.runId,
        content: `Extract structured profile context for ${item.targetName} to improve the connection note.`,
        eventName: "browser-command:extract-profile-enrichment",
        deliveryScope: "specific_tab",
        targetTabId: profileTabId,
        command: {
          kind: "extract_structured",
          tabId: profileTabId,
          scope: "main",
          schema: JSON.stringify({
            type: "object",
            properties: {
              title: { type: "string" },
              headline: { type: "string" },
              summary: { type: "string" },
            },
          }),
          promptHint:
            "Capture the visible LinkedIn profile title, headline, and short summary for a concise connection note.",
        },
        summarize: (resultDoc, status) => {
          if (status === "failed") {
            return `Failed to extract structured profile context for ${item.targetName}: ${resultDoc?.errorMessage ?? "unknown error"}`;
          }
          const observation = parseStructuredProfileObservation(item.targetUrl, resultDoc);
          const contextHint = observation?.headline ?? observation?.summary ?? "profile details";
          return `Captured structured profile context for ${item.targetName}: ${truncate(contextHint, 120)}.`;
        },
      });
      if (extractResult.completion.status === "completed") {
        const observation = parseStructuredProfileObservation(
          item.targetUrl,
          extractResult.resultDoc
        );
        if (observation) {
          profileObservations.push(observation);
        }
      }
    } finally {
      if (typeof profileTabId === "number") {
        await runQueuedBrowserCommand(step, {
          runId: args.runId,
          content: `Close the temporary LinkedIn profile tab for ${item.targetName}.`,
          eventName: "browser-command:close-profile-enrichment-tab",
          deliveryScope: "specific_tab",
          targetTabId: profileTabId,
          command: {
            kind: "close_tab",
            tabId: profileTabId,
          },
          summarize: (resultDoc, status) =>
            status === "failed"
              ? `Failed to close the temporary LinkedIn profile tab for ${item.targetName}: ${resultDoc?.errorMessage ?? "unknown error"}`
              : `Closed the temporary LinkedIn profile tab for ${item.targetName}.`,
        });
      }
    }
  }

  return enrichLinkedInSearchBatchItems({
    items: args.items,
    profileObservations,
  });
}

async function maybeGenerateModelBackedLinkedInDrafts(step: any, args: {
  runId: Id<"agentRuns">;
  userId: Id<"users">;
  goal: string;
  decision: Extract<
    PlannerDecision,
    { kind: "request_approval"; approvalKind: "connect" }
  >;
}): Promise<
  Extract<PlannerDecision, { kind: "request_approval"; approvalKind: "connect" }>
> {
  if (
    args.decision.payload.actionType !== "create_task_batch" ||
    args.decision.payload.batchType !== "linkedin_connect"
  ) {
    return args.decision;
  }

  const draftResult = await step.runAction(
    internal.agentPlanner.generateLinkedInConnectDrafts,
    {
      userId: args.userId,
      goal: args.goal,
      items: args.decision.payload.items,
    },
    { name: "generate linkedin connect drafts" }
  );

  const draftSummary =
    draftResult.source === "model"
      ? `Generated model-backed LinkedIn connection drafts for ${draftResult.items.length} candidate${draftResult.items.length === 1 ? "" : "s"}.`
      : `Retained heuristic LinkedIn connection drafts for ${draftResult.items.length} candidate${draftResult.items.length === 1 ? "" : "s"}${draftResult.errorMessage ? ` because ${draftResult.errorMessage}` : "."}`;

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "planner",
      content: draftSummary,
      toolCall: {
        phase: "draft_generation",
        source: draftResult.source,
        itemCount: draftResult.items.length,
      },
    },
    { inline: true, name: "append draft generation step" }
  );
  await maybeAppendRollingSummary(step, args.runId);

  return {
    ...args.decision,
    generatedText: draftResult.items[0]?.generatedText,
    payload: {
      ...args.decision.payload,
      items: draftResult.items,
    },
  };
}

async function generateConversationDraftDecision(step: any, args: {
  runId: Id<"agentRuns">;
  userId: Id<"users">;
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext: string;
  fieldTarget: AgentFieldTarget;
}): Promise<PlannerDecision> {
  const draftResult = await step.runAction(
    internal.agentPlanner.generateConversationDraft,
    {
      userId: args.userId,
      goal: args.goal,
      platformHint: args.platformHint,
      pageContext: args.pageContext,
      fieldTarget: args.fieldTarget,
    },
    { name: "generate conversation draft" }
  );

  const draftSummary =
    draftResult.source === "model"
      ? "Generated a model-backed draft for the current compose field."
      : `Unable to generate a model-backed draft: ${draftResult.errorMessage ?? "unknown error"}`;

  await step.runMutation(
    internal.agentRuns.appendStep,
    {
      runId: args.runId,
      role: "planner",
      content: draftSummary,
      toolCall: {
        phase: "draft_generation",
        source: draftResult.source,
      },
    },
    { inline: true, name: "append conversation draft generation step" }
  );
  await maybeAppendRollingSummary(step, args.runId);

  if (!draftResult.generatedText) {
    return {
      kind: "complete",
      strategicPlan:
        "The run had enough context to attempt a direct draft, but draft generation failed, so it should stop safely instead of inserting low-confidence text.",
      tacticalPlan:
        "Complete the run with a summary rather than creating an approval for a missing or unusable draft.",
      summary:
        draftResult.errorMessage ??
        "The planner could not generate a usable draft for the current compose field.",
    };
  }

  return deriveConversationDraftDecision({
    goal: args.goal,
    platformHint: args.platformHint,
    pageUrl: args.pageUrl,
    pageContext: args.pageContext,
    fieldTarget: args.fieldTarget,
    generatedText: draftResult.generatedText,
  });
}

async function insertApprovedDraft(step: any, args: {
  runId: Id<"agentRuns">;
  targetTabId: number;
  platformHint?: string;
  decision: Extract<PlannerDecision, {
    kind: "request_approval";
    approvalKind: "draft_insert";
  }>;
}): Promise<"completed" | "failed"> {
  const insertResult = await runQueuedBrowserCommand(step, {
    runId: args.runId,
    content: "Insert the approved draft into the captured compose field.",
    eventName: "browser-command:insert-approved-draft",
    deliveryScope: "specific_tab",
    targetTabId: args.targetTabId,
    command: {
      kind: "insert_text",
      tabId: args.targetTabId,
      selector: args.decision.payload.fieldTarget.selector,
      text: args.decision.payload.generatedText,
      platform:
        args.decision.payload.fieldTarget.platform ?? args.platformHint,
    },
    summarize: (resultDoc, status) =>
      status === "failed"
        ? `Failed to insert the approved draft into the compose field: ${resultDoc?.errorMessage ?? "unknown error"}`
        : "Inserted the approved draft into the compose field.",
  });
  if (insertResult.completion.status === "failed") {
    return "failed";
  }

  const verifyResult = await runQueuedBrowserCommand(step, {
    runId: args.runId,
    content: "Verify that the inserted draft text is present in the compose field.",
    eventName: "browser-command:verify-approved-draft",
    deliveryScope: "specific_tab",
    targetTabId: args.targetTabId,
    command: {
      kind: "verify_text",
      tabId: args.targetTabId,
      selector: args.decision.payload.fieldTarget.selector,
      expectedText:
        args.decision.payload.verifyText ||
        buildDraftVerificationText(args.decision.payload.generatedText),
      maxLength: Math.max(200, args.decision.payload.verifyText.length + 50),
    },
    summarize: (resultDoc, status) => {
      if (status === "failed") {
        return `Failed to verify the inserted draft text: ${resultDoc?.errorMessage ?? "unknown error"}`;
      }
      const matched =
        (resultDoc?.result as { matched?: boolean } | undefined)?.matched === true;
      return matched
        ? "Verified the inserted draft text in the compose field."
        : "Draft insertion completed, but text verification did not confirm the expected content.";
    },
  });
  if (verifyResult.completion.status === "failed") {
    return "failed";
  }

  const matched =
    (verifyResult.resultDoc?.result as { matched?: boolean } | undefined)?.matched ===
    true;
  return matched ? "completed" : "failed";
}

export const bootstrapObservationRun = workflow.define({
  args: {
    runId: v.id("agentRuns"),
    userId: v.id("users"),
    goal: v.string(),
    platformHint: v.optional(v.string()),
    targetTabId: v.number(),
    pageUrl: v.optional(v.string()),
    initialPageContext: v.optional(v.string()),
    fieldTarget: v.optional(agentFieldTargetValidator),
  },
  returns: v.null(),
  handler: async (step, args): Promise<null> => {
    await step.runMutation(
      internal.agentRuns.setRunStatus,
      {
        runId: args.runId,
        status: "planning",
      },
      { inline: true, name: "set planning status" }
    );

    await step.runMutation(
      internal.agentRuns.appendStep,
      {
        runId: args.runId,
        role: "system",
        content: `Started durable agent run for goal: ${truncate(args.goal.trim(), 280)}`,
      },
      { inline: true, name: "append start step" }
    );

    if (args.pageUrl) {
      await step.runMutation(
        internal.agentRuns.registerRunTab,
        {
          runId: args.runId,
          tabId: args.targetTabId,
          url: args.pageUrl,
        },
        { inline: true, name: "register source tab" }
      );
    }

    await step.runMutation(
      internal.agentRuns.setRunStatus,
      {
        runId: args.runId,
        status: "executing",
      },
      { inline: true, name: "set executing status" }
    );

    const resultSummaries: string[] = [];
    let currentPageUrl = args.pageUrl;
    let plannerDecision: PlannerDecision | null = null;
    let searchAccumulatedItems: PlannerBatchItem[] = [];

    const isLinkedInSearchFlow =
      isLinkedInConnectIntent(args.goal) &&
      isLinkedInSearchResultsContext(args.platformHint, args.pageUrl);
    const requestedConnectCount = parseRequestedConnectCount(args.goal);

    if (
      shouldUseConversationDraftFlow({
        goal: args.goal,
        platformHint: args.platformHint,
        pageUrl: args.pageUrl,
        pageContext: args.initialPageContext,
        fieldTarget: args.fieldTarget,
      })
    ) {
      plannerDecision = await generateConversationDraftDecision(step, {
        runId: args.runId,
        userId: args.userId,
        goal: args.goal,
        platformHint: args.platformHint,
        pageUrl: args.pageUrl,
        pageContext: args.initialPageContext!,
        fieldTarget: args.fieldTarget!,
      });
    }

    for (
      let passIndex = 0;
      !plannerDecision &&
      passIndex <
        (isLinkedInSearchFlow ? MAX_LINKEDIN_SEARCH_COLLECTION_PASSES : 1);
      passIndex += 1
    ) {
      if (!isLinkedInSearchFlow) {
        const observationPass = await runBootstrapObservationPass(step, {
          runId: args.runId,
          targetTabId: args.targetTabId,
        });
        if (!observationPass) {
          return null;
        }

        resultSummaries.push(...observationPass.resultSummaries);

        await maybeAppendRollingPlannerSummary(step, {
          runId: args.runId,
          goal: args.goal,
        });

        plannerDecision = await step.runAction(
          internal.agentPlanner.planBootstrapRun,
          {
            goal: args.goal,
            platformHint: args.platformHint,
            pageUrl: currentPageUrl,
            interactiveSummary: observationPass.interactiveSummary,
            accessibilitySummary: observationPass.accessibilitySummary,
            interactiveElements: observationPass.interactiveElements,
            structured: observationPass.structuredResult,
          },
          { name: "plan bootstrap run" }
        );
        break;
      }

      const scanPass = await runLinkedInCandidateScanPass(step, {
        runId: args.runId,
        targetTabId: args.targetTabId,
        maxResults: requestedConnectCount,
      });
      if (!scanPass) {
        return null;
      }

      resultSummaries.push(scanPass.resultSummary);

      await maybeAppendRollingPlannerSummary(step, {
        runId: args.runId,
        goal: args.goal,
      });

      const searchDecision = await step.runAction(
        internal.agentPlanner.planLinkedInSearchCollection,
        {
          goal: args.goal,
          pageUrl: currentPageUrl,
          scannedCandidates: scanPass.scannedCandidates,
          nextPageUrl: scanPass.nextPageUrl ?? undefined,
          accumulatedItems: searchAccumulatedItems,
        },
        { name: "plan linkedin search collection" }
      );

      await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "planner",
          content: searchDecision.strategicPlan,
          toolCall: {
            phase: "strategic_plan",
            kind: searchDecision.kind,
          },
        },
        { inline: true, name: "append search strategic plan" }
      );
      await maybeAppendRollingSummary(step, args.runId);

      await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "planner",
          content: searchDecision.tacticalPlan,
          toolCall: {
            phase: "tactical_plan",
            kind: searchDecision.kind,
          },
        },
        { inline: true, name: "append search tactical plan" }
      );
      await maybeAppendRollingSummary(step, args.runId);

      if (searchDecision.kind !== "collect_more") {
        plannerDecision = searchDecision;
        break;
      }

      searchAccumulatedItems = searchDecision.accumulatedItems;

      const navigationStep = await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "browser_command",
          content: "Navigate to the next LinkedIn search results page.",
          toolCall: {
            kind: "navigate",
            tabId: args.targetTabId,
            url: searchDecision.nextPageUrl,
          },
        },
        { inline: true, name: "append next-page navigation step" }
      );

      const completionEventId = await workflow.createEvent(step, {
        name: "browser-command:navigate-search-results",
        workflowId: step.workflowId,
      });

      const commandEntry = await step.runMutation(
        internal.agentRuns.enqueueBrowserCommand,
        {
          runId: args.runId,
          stepId: navigationStep.stepId as Id<"agentRunSteps">,
          deliveryScope: "specific_tab",
          targetTabId: args.targetTabId,
          command: {
            kind: "navigate",
            tabId: args.targetTabId,
            url: searchDecision.nextPageUrl,
          },
          completionEventId: completionEventId as string,
        },
        { inline: true, name: "enqueue next-page navigation" }
      );

      await step.runMutation(
        internal.agentRuns.scheduleBrowserCommandTimeout,
        {
          commandId: commandEntry.commandId as Id<"browserCommands">,
          timeoutMs: BOOTSTRAP_BROWSER_COMMAND_TIMEOUT_MS,
        },
        { inline: true, name: "schedule next-page navigation timeout" }
      );

      const navigationCompletion = await step.awaitEvent({
        id: completionEventId,
        validator: browserCommandCompletionEventValidator,
      });

      const navigationResult = await step.runQuery(
        internal.agentRuns.getBrowserCommandResultForWorkflow,
        {
          commandId: commandEntry.commandId as Id<"browserCommands">,
        },
        { inline: true, name: "read next-page navigation result" }
      );

      const navigationSummary =
        navigationCompletion.status === "completed"
          ? `Navigated to the next LinkedIn search results page (${searchDecision.nextPageUrl}).`
          : `Failed to navigate to the next LinkedIn search results page: ${navigationResult?.errorMessage ?? "unknown error"}`;

      await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "browser_result",
          content: navigationSummary,
          commandId: navigationCompletion.commandId,
          toolCall: navigationResult?.result,
        },
        { inline: true, name: "append next-page navigation result" }
      );
      await maybeAppendRollingSummary(step, args.runId);

      if (navigationCompletion.status === "failed") {
        await step.runMutation(
          internal.agentRuns.setRunStatus,
          {
            runId: args.runId,
            status: "failed",
            lastError:
              navigationResult?.errorMessage ??
              "Failed to navigate to the next LinkedIn search results page",
          },
          { inline: true, name: "fail after next-page navigation" }
        );
        return null;
      }

      currentPageUrl = searchDecision.nextPageUrl;
    }

    if (!plannerDecision && isLinkedInSearchFlow) {
      const finalSearchDecision = await step.runAction(
        internal.agentPlanner.planLinkedInSearchCollection,
        {
          goal: args.goal,
          pageUrl: currentPageUrl,
          scannedCandidates: [],
          accumulatedItems: searchAccumulatedItems,
        },
        { name: "finalize linkedin search collection" }
      );
      if (finalSearchDecision.kind === "collect_more") {
        await step.runMutation(
          internal.agentRuns.setRunStatus,
          {
            runId: args.runId,
            status: "failed",
            lastError: "Planner did not converge to a terminal decision",
          },
          { inline: true, name: "fail non-terminal planner decision" }
        );
        return null;
      }
      plannerDecision = finalSearchDecision;
    }

    if (!plannerDecision) {
      await step.runMutation(
        internal.agentRuns.setRunStatus,
        {
          runId: args.runId,
          status: "failed",
          lastError: "Planner did not converge to a terminal decision",
        },
        { inline: true, name: "fail non-terminal planner decision" }
      );
      return null;
    }

    let terminalDecision: PlannerDecision = plannerDecision;

    if (
      isLinkedInSearchFlow &&
      terminalDecision.kind === "request_approval" &&
      terminalDecision.payload.actionType === "create_task_batch"
    ) {
      const connectDecision =
        terminalDecision as Extract<
          PlannerDecision,
          { kind: "request_approval"; approvalKind: "connect" }
        >;
      terminalDecision = {
        ...connectDecision,
        payload: {
          ...connectDecision.payload,
          items: await enrichLinkedInSearchItemsWithProfileContext(step, {
            runId: args.runId,
            goal: args.goal,
            items: connectDecision.payload.items,
          }),
        },
      } as Extract<PlannerDecision, { kind: "request_approval"; approvalKind: "connect" }>;
    }

    await step.runMutation(
        internal.agentRuns.appendStep,
      {
        runId: args.runId,
        role: "planner",
        content: terminalDecision.strategicPlan,
        toolCall: {
          phase: "strategic_plan",
          kind: terminalDecision.kind,
        },
      },
      { inline: true, name: "append strategic plan" }
    );
    await maybeAppendRollingSummary(step, args.runId);

    await step.runMutation(
        internal.agentRuns.appendStep,
      {
        runId: args.runId,
        role: "planner",
        content: terminalDecision.tacticalPlan,
        toolCall: {
          phase: "tactical_plan",
          kind: terminalDecision.kind,
        },
      },
      { inline: true, name: "append tactical plan" }
    );
    await maybeAppendRollingSummary(step, args.runId);

    if (terminalDecision.kind === "request_approval") {
      if (terminalDecision.approvalKind === "connect") {
        terminalDecision = await maybeGenerateModelBackedLinkedInDrafts(step, {
          runId: args.runId,
          userId: args.userId,
          goal: args.goal,
          decision: terminalDecision,
        });
      }

      const approvalTarget = getPlannerApprovalTarget(terminalDecision);
      const approvalStep = await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "approval",
          content: terminalDecision.title,
          toolCall: {
            approvalKind: terminalDecision.approvalKind,
            ...(terminalDecision.generatedText
              ? { generatedText: terminalDecision.generatedText }
              : {}),
            itemCount: approvalTarget.itemCount,
          },
        },
        { inline: true, name: "append approval step" }
      );

      const approvalEventId = await workflow.createEvent(step, {
        name: `approval:${terminalDecision.approvalKind}`,
        workflowId: step.workflowId,
      });

      const approvalExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
      const approvalEntry = await step.runMutation(
        internal.agentRuns.createApproval,
        {
          runId: args.runId,
          stepId: approvalStep.stepId as Id<"agentRunSteps">,
          approvalKind: terminalDecision.approvalKind,
          title: terminalDecision.title,
          reason: terminalDecision.reason,
          payload: {
            ...terminalDecision.payload,
            ...(terminalDecision.generatedText
              ? { generatedText: terminalDecision.generatedText }
              : {}),
          },
          completionEventId: approvalEventId as string,
          expiresAt: approvalExpiresAt,
        },
        { inline: true, name: "create planner approval" }
      );

      await step.runMutation(
        internal.agentRuns.scheduleApprovalExpiry,
        {
          approvalId: approvalEntry.approvalId as Id<"agentApprovals">,
          expiresAt: approvalExpiresAt,
        },
        { inline: true, name: "schedule planner approval expiry" }
      );

      const approvalDecision = await step.awaitEvent({
        id: approvalEventId,
        validator: approvalDecisionEventValidator,
      });

      if (approvalDecision.decision !== "approved") {
        await step.runMutation(
          internal.agentRuns.appendStep,
          {
            runId: args.runId,
            role: "summary",
            content: `Run paused after ${approvalDecision.decision} approval for ${approvalTarget.label}.`,
            approvalId: approvalEntry.approvalId as Id<"agentApprovals">,
            summaryAfterStep: `Bootstrap planner reached an approval gate for ${approvalTarget.label}, but the approval was ${approvalDecision.decision}.`,
          },
          { inline: true, name: "append paused summary" }
        );

        await step.runMutation(
          internal.agentRuns.setRunStatus,
          {
            runId: args.runId,
            status: "paused",
            lastError: `Approval ${approvalDecision.decision}`,
          },
          { inline: true, name: "set paused after rejected approval" }
        );
        return null;
      }

      await step.runMutation(
        internal.agentRuns.setRunStatus,
        {
          runId: args.runId,
          status: "executing",
        },
        { inline: true, name: "resume after approval" }
      );

      if (terminalDecision.payload.actionType === "insert_draft") {
        const insertStatus = await insertApprovedDraft(step, {
          runId: args.runId,
          targetTabId: args.targetTabId,
          platformHint: args.platformHint,
          decision: terminalDecision as Extract<
            PlannerDecision,
            { kind: "request_approval"; approvalKind: "draft_insert" }
          >,
        });

        if (insertStatus === "failed") {
          await step.runMutation(
            internal.agentRuns.setRunStatus,
            {
              runId: args.runId,
              status: "failed",
              lastError: "Failed to insert or verify the approved draft",
            },
            { inline: true, name: "fail after approved draft insert" }
          );
          return null;
        }

        await step.runMutation(
          internal.agentRuns.appendStep,
          {
            runId: args.runId,
            role: "summary",
            content: "Inserted the approved draft into the current compose field.",
            approvalId: approvalEntry.approvalId as Id<"agentApprovals">,
            summaryAfterStep:
              "Inserted and verified the approved draft in the current compose field.",
          },
          { inline: true, name: "append draft insert summary" }
        );

        await step.runMutation(
          internal.agentRuns.setRunStatus,
          {
            runId: args.runId,
            status: "completed",
          },
          { inline: true, name: "set completed after draft insert" }
        );
        return null;
      }

      const batch = await step.runMutation(
        internal.tasks.createApprovedBatchForUser,
        {
          userId: args.userId,
          batchType: terminalDecision.payload.batchType,
          dailyLimit: terminalDecision.payload.dailyLimit,
          items: getBatchItemsFromDecision(terminalDecision),
        },
        { inline: true, name: "create deterministic batch handoff" }
      );

      await step.runMutation(
        internal.agentRuns.appendStep,
        {
          runId: args.runId,
          role: "summary",
          content: `Approved handoff created a deterministic batch for ${approvalTarget.label}.`,
          approvalId: approvalEntry.approvalId as Id<"agentApprovals">,
          summaryAfterStep: `Created deterministic approved ${terminalDecision.payload.batchType} batch ${String(batch.batchId)} with ${approvalTarget.itemCount} queued item${approvalTarget.itemCount === 1 ? "" : "s"} for ${approvalTarget.label}.`,
        },
        { inline: true, name: "append approved handoff summary" }
      );

      await step.runMutation(
        internal.agentRuns.setRunStatus,
        {
          runId: args.runId,
          status: "completed",
        },
        { inline: true, name: "set completed after handoff" }
      );
      return null;
    }

    await step.runMutation(
      internal.agentRuns.appendStep,
      {
        runId: args.runId,
        role: "summary",
        content: terminalDecision.summary,
        summaryAfterStep: `${resultSummaries.join(" ")} ${terminalDecision.summary}`.trim(),
      },
      { inline: true, name: "append workflow summary" }
    );

    await step.runMutation(
      internal.agentRuns.setRunStatus,
      {
        runId: args.runId,
        status: "completed",
      },
      { inline: true, name: "set completed status" }
    );

    return null;
  },
});
