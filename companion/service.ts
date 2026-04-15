import { callProvider } from "../convex/llmProvider.ts";
import {
  applyLinkedInConnectDrafts,
  buildConversationDraftPrompt,
  buildDraftVerificationText,
  buildLinkedInConnectDraftPrompt,
  deriveBootstrapPlannerDecision,
  deriveConversationDraftDecision,
  isLinkedInConnectIntent,
  isLinkedInSearchResultsContext,
  normalizeConversationDraft,
  planLinkedInSearchCollectionPass,
  shouldUseConversationDraftFlow,
  type PlannerBatchItem,
  type PlannerDecision,
} from "../src/lib/agent-planner.ts";
import type {
  LocalCompanionAction,
  LocalCompanionPanelState,
  LocalCompanionProviderConfig,
  LocalCompanionReportActionResult,
  LocalCompanionResolveApprovalResult,
  LocalCompanionStartRunParams,
  LocalCompanionStartRunResult,
} from "../src/lib/local-agent-protocol.ts";
import {
  CompanionStateStore,
  type StoredApprovalRecord,
  type StoredRunRecord,
} from "./state-store.ts";
import { ChromeDevtoolsMcpRuntime } from "./chrome-devtools-mcp-runtime.ts";
import {
  createNoopCompanionLogger,
  type CompanionLogger,
} from "./live-logger.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildSearchApprovalDecision(args: {
  items: PlannerBatchItem[];
  requestedCount: number;
  partial: boolean;
}): PlannerDecision {
  const countLabel = args.partial
    ? `${args.items.length} visible`
    : `${Math.min(args.items.length, args.requestedCount)}`;
  return {
    kind: "request_approval",
    strategicPlan:
      "Use the visible LinkedIn people-search observations to hand off a reviewed deterministic batch instead of attempting an irreversible browser action directly.",
    tacticalPlan: args.partial
      ? `Queue the ${countLabel} candidate${args.items.length === 1 ? "" : "s"} already collected on this LinkedIn search page and leave deeper pagination for a later browser-backed slice.`
      : `Queue ${countLabel} LinkedIn connection request${args.items.length === 1 ? "" : "s"} from the current search pass and wait for approval before handoff.`,
    approvalKind: "connect",
    title:
      args.items.length === 1
        ? `Queue LinkedIn connection request for ${args.items[0]?.targetName ?? "this profile"}`
        : `Queue ${countLabel} LinkedIn connection requests`,
    reason:
      "Connection requests are irreversible platform actions and must be approved before deterministic queue handoff.",
    payload: {
      actionType: "create_task_batch",
      batchType: "linkedin_connect",
      dailyLimit: args.items.length,
      items: args.items,
    },
  };
}

function coerceActionFromApproval(
  approval: StoredApprovalRecord
): LocalCompanionAction | null {
  const payload = approval.payload;
  if (!isPlainObject(payload) || typeof payload.actionType !== "string") {
    return null;
  }

  if (payload.actionType === "insert_draft") {
    if (
      !isPlainObject(payload.fieldTarget) ||
      typeof payload.fieldTarget.selector !== "string" ||
      typeof payload.generatedText !== "string"
    ) {
      return null;
    }

    return {
      kind: "insert_draft",
      fieldTarget: {
        selector: payload.fieldTarget.selector,
        ...(typeof payload.fieldTarget.platform === "string"
          ? { platform: payload.fieldTarget.platform }
          : {}),
        ...(typeof payload.fieldTarget.fieldType === "string"
          ? { fieldType: payload.fieldTarget.fieldType }
          : {}),
        ...(typeof payload.fieldTarget.charLimit === "number"
          ? { charLimit: payload.fieldTarget.charLimit }
          : {}),
      },
      generatedText: payload.generatedText,
      verifyText:
        typeof payload.verifyText === "string" && payload.verifyText.trim()
          ? payload.verifyText
          : buildDraftVerificationText(payload.generatedText),
      ...(typeof payload.targetName === "string"
        ? { targetName: payload.targetName }
        : {}),
      ...(typeof payload.pageUrl === "string" ? { pageUrl: payload.pageUrl } : {}),
    };
  }

  if (payload.actionType === "create_task_batch") {
    if (
      typeof payload.batchType !== "string" ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      return null;
    }

    const items = payload.items
      .map((item) => {
        if (!isPlainObject(item) || typeof item.targetUrl !== "string") {
          return null;
        }
        return {
          targetUrl: item.targetUrl,
          ...(typeof item.targetName === "string"
            ? { targetName: item.targetName }
            : {}),
          ...(typeof item.generatedText === "string"
            ? { generatedText: item.generatedText }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (items.length === 0) {
      return null;
    }

    return {
      kind: "enqueue_task_batch",
      batchType: payload.batchType,
      dailyLimit:
        typeof payload.dailyLimit === "number" && Number.isFinite(payload.dailyLimit)
          ? Math.max(1, Math.min(100, Math.round(payload.dailyLimit)))
          : items.length,
      items,
    };
  }

  return null;
}

export class LocalAgentCompanionService {
  private readonly runtime: ChromeDevtoolsMcpRuntime;
  private readonly logger: CompanionLogger;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private runtimeHealth:
    | {
        connected: boolean;
        error?: string;
        checkedAt: number;
      }
    | null = null;
  private runtimeHealthRefreshPromise:
    | Promise<{
        connected: boolean;
        error?: string;
      }>
    | null = null;

  constructor(
    private readonly store = new CompanionStateStore(),
    private readonly llmCaller = callProvider,
    runtime?: ChromeDevtoolsMcpRuntime,
    logger: CompanionLogger = createNoopCompanionLogger()
  ) {
    this.logger = logger;
    this.runtime = runtime ?? new ChromeDevtoolsMcpRuntime({ logger });
    this.logger.event("info", "service", "constructed");
    this.ensureRuntimeHealthFresh(true);
  }

  async getPanelState(args: {
    userScope: string;
    limit?: number;
  }): Promise<LocalCompanionPanelState> {
    const panelState = await this.store.listPanelState(args.userScope, args.limit ?? 5);
    const runtimeHealth = this.getCachedRuntimeHealth();
    this.ensureRuntimeHealthFresh();
    return {
      ...panelState,
      runtimeConnected: runtimeHealth.connected,
      ...(runtimeHealth.error ? { runtimeError: runtimeHealth.error } : {}),
    };
  }

  async getHealth(): Promise<{
    ok: true;
    runtime: "local_companion";
    runtimeConnected: boolean;
    runtimeError?: string;
  }> {
    const runtimeHealth = await this.ensureRuntimeHealthFresh(true);
    return {
      ok: true,
      runtime: "local_companion",
      runtimeConnected: runtimeHealth.connected,
      ...(runtimeHealth.error ? { runtimeError: runtimeHealth.error } : {}),
    };
  }

  async startRun(
    params: LocalCompanionStartRunParams
  ): Promise<LocalCompanionStartRunResult> {
    const run = await this.store.createRun({
      userScope: params.userScope,
      goal: params.goal,
      platformHint: params.platformHint,
      pageUrl: params.pageUrl,
      pageContext: params.pageContext,
      fieldTarget: params.fieldTarget,
    });

    try {
      this.logger.event("info", "service", "start_run", {
        runId: run._id,
        goal: params.goal,
        platformHint: params.platformHint,
        pageUrl: params.pageUrl,
        hasProviderConfig: Boolean(params.providerConfig?.apiKey),
        provider: params.providerConfig?.provider,
        model: params.providerConfig?.model,
      });
      await this.store.updateRun(params.userScope, run._id, {
        status: "planning",
        latestSummary: "Planning the next safe action in the local companion.",
      });
      await this.planRun(run, params);
      return {
        runId: run._id,
        runtimeId: run._id,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.event("error", "service", "start_run_failed", {
        runId: run._id,
        message,
      });
      await this.store.updateRun(params.userScope, run._id, {
        status: "failed",
        latestSummary: message,
        lastError: message,
        completedAt: Date.now(),
      });
      throw error;
    }
  }

  async resolveApproval(args: {
    userScope: string;
    approvalId: string;
    decision: "approved" | "rejected";
    decisionNote?: string;
  }): Promise<LocalCompanionResolveApprovalResult> {
    const approval = await this.store.getApproval(args.userScope, args.approvalId);
    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status === "approved") {
      this.logger.event("info", "service", "resolve_approval_resume", {
        approvalId: approval._id,
        runId: approval.runId,
      });
      const approvedAction = coerceActionFromApproval(approval);
      if (approvedAction) {
        if (!this.activeExecutions.has(approval._id)) {
          await this.store.updateRun(args.userScope, approval.runId, {
            status: "executing",
            latestSummary:
              "Resuming the previously approved action through the local Chrome MCP runtime.",
          });
          this.startApprovedExecution(args.userScope, approval, approvedAction);
        }
        return {
          ok: true,
          status: "executing",
          runId: approval.runId,
        };
      }

      return {
        ok: true,
        status: "approved",
        runId: approval.runId,
      };
    }

    if (approval.status !== "pending") {
      return {
        ok: true,
        status: approval.status,
        runId: approval.runId,
      };
    }

    if (args.decision === "rejected") {
      this.logger.event("info", "service", "resolve_approval_rejected", {
        approvalId: approval._id,
        runId: approval.runId,
      });
      await this.store.updateApproval(args.userScope, approval._id, {
        status: "rejected",
      });
      await this.store.updateRun(args.userScope, approval.runId, {
        status: "cancelled",
        latestSummary:
          args.decisionNote?.trim() ||
          "The user rejected this approval gate, so the run was cancelled safely.",
        completedAt: Date.now(),
      });
      return {
        ok: true,
        status: "rejected",
        runId: approval.runId,
      };
    }

    const action = coerceActionFromApproval(approval);
    if (!action) {
      throw new Error("Approval payload does not describe an executable action");
    }

    this.logger.event("info", "service", "resolve_approval_approved", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
    });
    await this.store.updateApproval(args.userScope, approval._id, {
      status: "approved",
    });
    await this.store.updateRun(args.userScope, approval.runId, {
      status: "executing",
      latestSummary:
        "Approval granted. Executing the reviewed action through the local Chrome MCP runtime.",
    });

    this.startApprovedExecution(args.userScope, approval, action);

    return {
      ok: true,
      status: "executing",
      runId: approval.runId,
    };
  }

  async reportActionResult(args: {
    userScope: string;
    approvalId: string;
    succeeded: boolean;
    summary?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LocalCompanionReportActionResult> {
    const approval = await this.store.getApproval(args.userScope, args.approvalId);
    if (!approval) {
      throw new Error("Approval not found");
    }

    await this.store.updateApproval(args.userScope, approval._id, {
      status: args.succeeded ? "completed" : "failed",
      ...(args.metadata ? { payload: { ...(approval.payload ?? {}), actionResult: args.metadata } } : {}),
    });

    if (args.succeeded) {
      await this.store.updateRun(args.userScope, approval.runId, {
        status: "completed",
        latestSummary:
          args.summary?.trim() || "Approved action completed successfully.",
        completedAt: Date.now(),
        lastError: undefined,
      });
      return {
        ok: true,
        status: "completed",
        runId: approval.runId,
      };
    }

    const message = args.errorMessage?.trim() || "Approved action failed.";
    await this.store.updateRun(args.userScope, approval.runId, {
      status: "failed",
      latestSummary: message,
      lastError: message,
      completedAt: Date.now(),
    });
    return {
      ok: true,
      status: "failed",
      runId: approval.runId,
    };
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  private getCachedRuntimeHealth(): {
    connected: boolean;
    error?: string;
  } {
    if (this.runtimeHealth) {
      return {
        connected: this.runtimeHealth.connected,
        ...(this.runtimeHealth.error ? { error: this.runtimeHealth.error } : {}),
      };
    }

    return {
      connected: false,
      error: "Starting local browser runtime.",
    };
  }

  private ensureRuntimeHealthFresh(
    force = false
  ): Promise<{
    connected: boolean;
    error?: string;
  }> {
    const now = Date.now();
    const maxAgeMs = this.runtimeHealth?.connected ? 5_000 : 15_000;
    if (
      !force &&
      this.runtimeHealth &&
      now - this.runtimeHealth.checkedAt < maxAgeMs
    ) {
      return Promise.resolve({
        connected: this.runtimeHealth.connected,
        ...(this.runtimeHealth.error ? { error: this.runtimeHealth.error } : {}),
      });
    }

    if (this.runtimeHealthRefreshPromise) {
      return this.runtimeHealthRefreshPromise;
    }

    this.runtimeHealthRefreshPromise = this.runtime
      .checkAvailability()
      .then((health) => {
        this.logger.event(
          health.connected ? "info" : "warn",
          "runtime",
          "health",
          {
            connected: health.connected,
            ...(health.error ? { error: health.error } : {}),
          }
        );
        this.runtimeHealth = {
          connected: health.connected,
          ...(health.error ? { error: health.error } : {}),
          checkedAt: Date.now(),
        };
        return health;
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.event("error", "runtime", "health_failed", {
          message,
        });
        const health = {
          connected: false,
          error: message,
        };
        this.runtimeHealth = {
          ...health,
          checkedAt: Date.now(),
        };
        return health;
      })
      .finally(() => {
        this.runtimeHealthRefreshPromise = null;
      });

    return this.runtimeHealthRefreshPromise;
  }

  private async planRun(
    run: StoredRunRecord,
    params: LocalCompanionStartRunParams
  ): Promise<void> {
    if (
      shouldUseConversationDraftFlow({
        goal: params.goal,
        platformHint: params.platformHint,
        pageUrl: params.pageUrl,
        pageContext: params.pageContext,
        fieldTarget: params.fieldTarget,
      })
    ) {
      await this.planConversationDraft(run, params);
      return;
    }

    if (
      isLinkedInConnectIntent(params.goal) &&
      isLinkedInSearchResultsContext(params.platformHint, params.pageUrl)
    ) {
      await this.planLinkedInSearch(run, params);
      return;
    }

    let decision = deriveBootstrapPlannerDecision({
      goal: params.goal,
      platformHint: params.platformHint,
      pageUrl: params.pageUrl,
      structured: params.structured ?? null,
    });

    if (
      decision.kind === "request_approval" &&
      decision.approvalKind === "connect" &&
      decision.payload.actionType === "create_task_batch" &&
      params.providerConfig
    ) {
      decision = {
        ...decision,
        payload: {
          ...decision.payload,
          items: await this.maybeRefineLinkedInItems(
            params.goal,
            decision.payload.items,
            params.providerConfig
          ),
        },
      };
    }

    await this.applyPlannerDecision(run, params.userScope, decision);
  }

  private async planConversationDraft(
    run: StoredRunRecord,
    params: LocalCompanionStartRunParams
  ): Promise<void> {
    if (!params.pageContext || !params.fieldTarget?.selector) {
      throw new Error("Conversation draft flow requires page context and a field target");
    }
    if (!params.providerConfig) {
      throw new Error("Missing API key for the configured provider. Add it in Settings.");
    }

    const charLimit =
      typeof params.fieldTarget.charLimit === "number"
        ? Math.max(1, Math.min(3000, Math.round(params.fieldTarget.charLimit)))
        : 800;
    const prompt = buildConversationDraftPrompt({
      goal: params.goal,
      platformHint: params.platformHint,
      pageContext: params.pageContext,
      charLimit,
    });
    this.logger.event("info", "llm", "conversation_draft_start", {
      runId: run._id,
      provider: params.providerConfig.provider,
      model: params.providerConfig.model,
      charLimit,
      userChars: prompt.user.length,
      systemChars: prompt.system.length,
    });
    const rawDraft = await this.llmCaller({
      provider: params.providerConfig.provider,
      model: params.providerConfig.model,
      apiKey: params.providerConfig.apiKey,
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: Math.max(256, Math.min(2_000, charLimit * 2)),
      temperature: 0.4,
    });
    const generatedText = normalizeConversationDraft(rawDraft, charLimit);
    if (!generatedText) {
      throw new Error("The local companion could not produce a usable draft");
    }
    this.logger.event("info", "llm", "conversation_draft_success", {
      runId: run._id,
      outputChars: generatedText.length,
    });

    const decision = deriveConversationDraftDecision({
      goal: params.goal,
      platformHint: params.platformHint,
      pageUrl: params.pageUrl,
      pageContext: params.pageContext,
      fieldTarget: params.fieldTarget,
      generatedText,
    });
    await this.applyPlannerDecision(run, params.userScope, decision);
  }

  private async planLinkedInSearch(
    run: StoredRunRecord,
    params: LocalCompanionStartRunParams
  ): Promise<void> {
    const searchDecision = planLinkedInSearchCollectionPass({
      goal: params.goal,
      pageUrl: params.pageUrl,
      scannedCandidates: params.scannedCandidates,
      nextPageUrl: params.nextPageUrl,
    });
    this.logger.event("info", "planner", "linkedin_search_pass", {
      runId: run._id,
      resultKind: searchDecision.kind,
      scannedCandidateCount: params.scannedCandidates?.length ?? 0,
      hasNextPageUrl: Boolean(params.nextPageUrl),
    });

    if (searchDecision.kind === "collect_more") {
      if (searchDecision.accumulatedItems.length === 0) {
        await this.store.updateRun(params.userScope, run._id, {
          status: "completed",
          latestSummary:
            "The current LinkedIn search page did not expose enough high-confidence candidates to queue safely.",
          completedAt: Date.now(),
        });
        return;
      }

      let items = searchDecision.accumulatedItems;
      if (params.providerConfig) {
        items = await this.maybeRefineLinkedInItems(
          params.goal,
          items,
          params.providerConfig
        );
      }
      await this.applyPlannerDecision(
        run,
        params.userScope,
        buildSearchApprovalDecision({
          items,
          requestedCount: searchDecision.requestedCount,
          partial: true,
        })
      );
      return;
    }

    let decision: PlannerDecision = searchDecision;
    if (
      decision.kind === "request_approval" &&
      decision.approvalKind === "connect" &&
      decision.payload.actionType === "create_task_batch" &&
      params.providerConfig
    ) {
      decision = {
        ...decision,
        payload: {
          ...decision.payload,
          items: await this.maybeRefineLinkedInItems(
            params.goal,
            decision.payload.items,
            params.providerConfig
          ),
        },
      };
    }

    await this.applyPlannerDecision(run, params.userScope, decision);
  }

  private async maybeRefineLinkedInItems(
    goal: string,
    items: PlannerBatchItem[],
    providerConfig: LocalCompanionProviderConfig
  ): Promise<PlannerBatchItem[]> {
    if (items.length === 0) {
      return items;
    }

    try {
      const prompt = buildLinkedInConnectDraftPrompt({
        goal,
        items,
      });
      this.logger.event("info", "llm", "linkedin_refine_start", {
        provider: providerConfig.provider,
        model: providerConfig.model,
        itemCount: items.length,
        userChars: prompt.user.length,
        systemChars: prompt.system.length,
      });
      const responseText = await this.llmCaller({
        provider: providerConfig.provider,
        model: providerConfig.model,
        apiKey: providerConfig.apiKey,
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: Math.max(512, Math.min(2_000, items.length * 220)),
        temperature: 0.4,
      });
      const applied = applyLinkedInConnectDrafts({
        items,
        responseText,
      });
      this.logger.event("info", "llm", "linkedin_refine_success", {
        itemCount: items.length,
        source: applied.source,
      });
      return applied.items;
    } catch {
      this.logger.event("warn", "llm", "linkedin_refine_failed", {
        itemCount: items.length,
      });
      return items;
    }
  }

  private async applyPlannerDecision(
    run: StoredRunRecord,
    userScope: string,
    decision: PlannerDecision
  ): Promise<void> {
    if (decision.kind === "complete") {
      this.logger.event("info", "planner", "decision_complete", {
        runId: run._id,
        summary: decision.summary,
      });
      await this.store.updateRun(userScope, run._id, {
        status: "completed",
        latestSummary: decision.summary,
        completedAt: Date.now(),
      });
      return;
    }

    if (decision.kind === "execute") {
      this.logger.event("info", "planner", "decision_execute", {
        runId: run._id,
        actionType: decision.payload.actionType,
        targetUrl: decision.payload.targetUrl,
      });
      await this.store.updateRun(userScope, run._id, {
        status: "executing",
        latestSummary: decision.tacticalPlan,
      });
      this.startDirectExecution(userScope, run._id, decision.payload);
      return;
    }

    this.logger.event("info", "planner", "decision_request_approval", {
      runId: run._id,
      approvalKind: decision.approvalKind,
      title: decision.title,
    });
    await this.store.createApproval({
      userScope,
      runId: run._id,
      approvalKind: decision.approvalKind,
      title: decision.title,
      reason: decision.reason,
      payload: decision.payload,
    });
    await this.store.updateRun(userScope, run._id, {
      status: "awaiting_approval",
      latestSummary: decision.tacticalPlan,
    });
  }

  private startDirectExecution(
    userScope: string,
    runId: string,
    payload: Extract<PlannerDecision, { kind: "execute" }>["payload"]
  ): void {
    const executionKey = `run:${runId}`;
    if (this.activeExecutions.has(executionKey)) {
      return;
    }

    const execution = this.executeDirectAction(userScope, runId, payload)
      .catch(async (error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        await this.store.updateRun(userScope, runId, {
          status: "failed",
          latestSummary: message,
          lastError: message,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        this.activeExecutions.delete(executionKey);
      });

    this.activeExecutions.set(executionKey, execution);
  }

  private startApprovedExecution(
    userScope: string,
    approval: StoredApprovalRecord,
    action: LocalCompanionAction
  ): void {
    if (this.activeExecutions.has(approval._id)) {
      return;
    }

    const execution = this.executeApprovedAction(userScope, approval, action)
      .catch(async (error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.event("error", "service", "approved_execution_failed", {
          approvalId: approval._id,
          runId: approval.runId,
          actionKind: action.kind,
          message,
        });
        await this.store.updateApproval(userScope, approval._id, {
          status: "failed",
          payload: {
            ...(approval.payload ?? {}),
            actionResult: {
              errorMessage: message,
            },
          },
        });
        await this.store.updateRun(userScope, approval.runId, {
          status: "failed",
          latestSummary: message,
          lastError: message,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        this.activeExecutions.delete(approval._id);
      });

    this.activeExecutions.set(approval._id, execution);
  }

  private async executeApprovedAction(
    userScope: string,
    approval: StoredApprovalRecord,
    action: LocalCompanionAction
  ): Promise<void> {
    const run = await this.store.getRun(userScope, approval.runId);
    if (!run) {
      throw new Error("Run not found for approval execution");
    }
    this.logger.event("info", "service", "approved_execution_start", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
    });

    let outcome:
      | {
          summary: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;

    if (action.kind === "insert_draft") {
      const pageUrl =
        action.pageUrl?.trim() || run.pageUrl?.trim();
      if (!pageUrl) {
        throw new Error(
          "The run does not have a page URL, so the approved draft cannot be inserted."
        );
      }
      outcome = await this.runtime.insertDraft({
        pageUrl,
        fieldTarget: action.fieldTarget,
        generatedText: action.generatedText,
        verifyText: action.verifyText,
        ...(action.targetName ? { targetName: action.targetName } : {}),
      });
    } else if (action.kind === "enqueue_task_batch") {
      if (action.batchType !== "linkedin_connect") {
        throw new Error(`Unsupported task batch type: ${action.batchType}`);
      }
      outcome = await this.runtime.executeLinkedInConnectBatch({
        items: action.items,
        dailyLimit: action.dailyLimit,
      });
      const sentCount =
        typeof outcome.metadata?.sent === "number" ? outcome.metadata.sent : 0;
      const failedCount =
        typeof outcome.metadata?.failed === "number" ? outcome.metadata.failed : 0;
      if (failedCount > 0 && sentCount === 0) {
        throw new Error(outcome.summary);
      }
    } else {
      throw new Error(`Unsupported companion action: ${(action as { kind: string }).kind}`);
    }

    await this.store.updateApproval(userScope, approval._id, {
      status: "completed",
      payload: {
        ...(approval.payload ?? {}),
        ...(outcome?.metadata ? { actionResult: outcome.metadata } : {}),
      },
    });
    await this.store.updateRun(userScope, approval.runId, {
      status: "completed",
      latestSummary:
        outcome?.summary || "Approved action completed successfully.",
      completedAt: Date.now(),
      lastError: undefined,
    });
    this.logger.event("info", "service", "approved_execution_complete", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
      summary: outcome?.summary,
    });
  }

  private async executeDirectAction(
    userScope: string,
    runId: string,
    payload: Extract<PlannerDecision, { kind: "execute" }>["payload"]
  ): Promise<void> {
    if (payload.actionType !== "navigate_url") {
      throw new Error(`Unsupported direct companion action: ${payload.actionType}`);
    }
    this.logger.event("info", "service", "direct_execution_start", {
      runId,
      actionType: payload.actionType,
      targetUrl: payload.targetUrl,
    });

    const outcome = await this.runtime.navigateToUrl({
      targetUrl: payload.targetUrl,
      ...(typeof payload.currentPageUrl === "string"
        ? { currentPageUrl: payload.currentPageUrl }
        : {}),
      ...(typeof payload.targetLabel === "string"
        ? { targetLabel: payload.targetLabel }
        : {}),
    });

    await this.store.updateRun(userScope, runId, {
      status: "completed",
      latestSummary: outcome.summary,
      completedAt: Date.now(),
      lastError: undefined,
    });
    this.logger.event("info", "service", "direct_execution_complete", {
      runId,
      actionType: payload.actionType,
      summary: outcome.summary,
    });
  }
}
