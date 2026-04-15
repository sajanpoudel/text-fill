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
} from "./state-store.ts";
import { ChromeDevtoolsMcpRuntime } from "./chrome-devtools-mcp-runtime.ts";
import {
  createNoopCompanionLogger,
  type CompanionLogger,
} from "./live-logger.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
          : payload.generatedText,
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
    if (!params.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to run Chrome MCP agent tasks."
      );
    }

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
        provider: params.providerConfig.provider,
        model: params.providerConfig.model,
      });
      await this.store.updateRun(params.userScope, run._id, {
        status: "executing",
        latestSummary:
          "Handing the task to the local Chrome MCP agent for tool-driven execution.",
      });
      this.startAgentTaskExecution(params.userScope, run._id, params);
      return {
        runId: run._id,
        runtimeId: run._id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    providerConfig?: LocalCompanionProviderConfig | null;
  }): Promise<LocalCompanionResolveApprovalResult> {
    const approval = await this.store.getApproval(args.userScope, args.approvalId);
    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status === "approved") {
      const approvedAction = coerceActionFromApproval(approval);
      if (approvedAction && !this.activeExecutions.has(approval._id)) {
        await this.store.updateRun(args.userScope, approval.runId, {
          status: "executing",
          latestSummary:
            "Resuming the previously approved action through the local Chrome MCP runtime.",
        });
        this.startApprovedExecution(
          args.userScope,
          approval,
          approvedAction,
          args.providerConfig ?? null
        );
      }
      return {
        ok: true,
        status: approvedAction ? "executing" : "approved",
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

    this.startApprovedExecution(
      args.userScope,
      approval,
      action,
      args.providerConfig ?? null
    );

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
      ...(args.metadata
        ? { payload: { ...(approval.payload ?? {}), actionResult: args.metadata } }
        : {}),
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
        const message = error instanceof Error ? error.message : String(error);
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

  private startApprovedExecution(
    userScope: string,
    approval: StoredApprovalRecord,
    action: LocalCompanionAction,
    providerConfig: LocalCompanionProviderConfig | null
  ): void {
    if (this.activeExecutions.has(approval._id)) {
      return;
    }

    const execution = this.executeApprovedAction(
      userScope,
      approval,
      action,
      providerConfig
    )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
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
    action: LocalCompanionAction,
    providerConfig: LocalCompanionProviderConfig | null
  ): Promise<void> {
    if (!providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings before approving browser actions."
      );
    }

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
      const pageUrl = action.pageUrl?.trim() || run.pageUrl?.trim();
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
        providerConfig,
        ...(action.targetName ? { targetName: action.targetName } : {}),
      });
    } else if (action.kind === "enqueue_task_batch") {
      if (action.batchType !== "linkedin_connect") {
        throw new Error(`Unsupported task batch type: ${action.batchType}`);
      }
      outcome = await this.runtime.executeLinkedInConnectBatch({
        items: action.items,
        dailyLimit: action.dailyLimit,
        providerConfig,
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

  private startAgentTaskExecution(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams
  ): void {
    const executionKey = `agent:${runId}`;
    if (this.activeExecutions.has(executionKey)) {
      return;
    }

    const execution = this.executeAgentTask(userScope, runId, params)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.event("error", "service", "agent_task_failed", {
          runId,
          message,
        });
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

  private async executeAgentTask(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams
  ): Promise<void> {
    if (!params.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to run Chrome MCP agent tasks."
      );
    }

    this.logger.event("info", "service", "agent_task_start", {
      runId,
      provider: params.providerConfig.provider,
      model: params.providerConfig.model,
      goal: params.goal,
      pageUrl: params.pageUrl,
    });

    const outcome = await this.runtime.executeAgentTask({
      providerConfig: params.providerConfig,
      goal: params.goal,
      ...(typeof params.pageUrl === "string" ? { pageUrl: params.pageUrl } : {}),
      ...(typeof params.platformHint === "string"
        ? { platformHint: params.platformHint }
        : {}),
      ...(typeof params.pageContext === "string"
        ? { pageContext: params.pageContext }
        : {}),
      ...(typeof params.userContext === "string"
        ? { userContext: params.userContext }
        : {}),
      ...(typeof params.systemPrompt === "string"
        ? { systemPrompt: params.systemPrompt }
        : {}),
      ...(params.fieldTarget ? { fieldTarget: params.fieldTarget } : {}),
      ...(params.structured ? { structured: params.structured } : {}),
      ...(params.scannedCandidates && params.scannedCandidates.length > 0
        ? { scannedCandidates: params.scannedCandidates }
        : {}),
    });

    await this.store.updateRun(userScope, runId, {
      status: "completed",
      latestSummary: outcome.summary,
      completedAt: Date.now(),
      lastError: undefined,
    });
    this.logger.event("info", "service", "agent_task_complete", {
      runId,
      summary: outcome.summary,
    });
  }
}
