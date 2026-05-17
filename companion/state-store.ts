import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  LocalCompanionApproval,
  LocalCompanionBrowserWorkItem,
  LocalCompanionFieldTarget,
  LocalCompanionPanelState,
  LocalCompanionRun,
  LocalCompanionRunProgress,
  LocalCompanionRunTask,
} from "../src/lib/local-agent-protocol.ts";

export interface StoredRunSiteMemoryItem {
  title: string;
  sourceType?: string;
  pagePattern?: string;
  itemGoal?: string;
}

export interface StoredRunSiteMemoryTaskPattern {
  title: string;
  status: LocalCompanionRunTask["status"];
  pagePattern?: string;
  resultSummary?: string;
  lastError?: string;
  skipReason?: string;
}

export interface StoredRunSiteMemory {
  host?: string;
  pagePattern?: string;
  workflowName?: string;
  queueType?: string;
  itemCount?: number;
  sourceTypes?: string[];
  exampleItems?: StoredRunSiteMemoryItem[];
  taskPatterns?: StoredRunSiteMemoryTaskPattern[];
  terminalStatus?: StoredRunRecord["status"];
  summary?: string;
  lastError?: string;
  updatedAt: number;
}

export interface StoredRunRecord extends LocalCompanionRun {
  userScope: string;
  pageUrl?: string;
  pageContext?: string;
  fieldTarget?: LocalCompanionFieldTarget;
  workItems?: LocalCompanionBrowserWorkItem[];
  siteMemory?: StoredRunSiteMemory;
  progress?: LocalCompanionRunProgress;
  tasks?: LocalCompanionRunTask[];
}

export interface StoredApprovalRecord extends LocalCompanionApproval {
  userScope: string;
  runId: string;
}

type StoredUserState = {
  runs: StoredRunRecord[];
  approvals: StoredApprovalRecord[];
};

type StoredState = {
  version: 1;
  users: Record<string, StoredUserState>;
};

function createEmptyState(): StoredState {
  return {
    version: 1,
    users: {},
  };
}

function createId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const suffix =
    typeof randomUUID === "function"
      ? randomUUID().replace(/-/g, "")
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${suffix}`;
}

export class CompanionStateStore {
  private cachedState: StoredState | null = null;
  private loadStatePromise: Promise<StoredState> | null = null;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath = resolve(
      process.cwd(),
      "companion/.data/state.json"
    )
  ) {}

  async listPanelState(
    userScope: string,
    limit: number
  ): Promise<LocalCompanionPanelState> {
    const state = await this.loadState();
    const userState = this.getUserState(state, userScope);
    const boundedLimit = Math.max(1, Math.min(20, Math.round(limit)));

    return {
      authenticated: true,
      approvals: [...userState.approvals]
        .filter((approval) => approval.status === "pending")
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, boundedLimit),
      runs: [...userState.runs]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, boundedLimit),
      runtime: "local_companion",
      runtimeConnected: true,
    };
  }

  async createRun(args: {
    userScope: string;
    goal: string;
    platformHint?: string;
    pageUrl?: string;
    pageContext?: string;
    fieldTarget?: LocalCompanionFieldTarget;
    resumeSourceRunId?: string;
    workItems?: LocalCompanionBrowserWorkItem[];
    siteMemory?: StoredRunSiteMemory;
    progress?: LocalCompanionRunProgress;
    tasks?: LocalCompanionRunTask[];
  }): Promise<StoredRunRecord> {
    return this.enqueueMutation(async (state) => {
      const now = Date.now();
      const run: StoredRunRecord = {
        _id: createId("run"),
        userScope: args.userScope,
        goal: args.goal,
        platformHint: args.platformHint,
        status: "created",
        latestSummary: "Run created.",
        createdAt: now,
        updatedAt: now,
        runtime: "local_companion",
        ...(args.pageUrl ? { pageUrl: args.pageUrl } : {}),
        ...(args.pageContext ? { pageContext: args.pageContext } : {}),
        ...(args.fieldTarget ? { fieldTarget: args.fieldTarget } : {}),
        ...(args.resumeSourceRunId ? { resumeSourceRunId: args.resumeSourceRunId } : {}),
        ...(args.workItems ? { workItems: args.workItems } : {}),
        ...(args.siteMemory ? { siteMemory: args.siteMemory } : {}),
        ...(args.progress ? { progress: args.progress } : {}),
        ...(args.tasks ? { tasks: args.tasks } : {}),
      };
      const userState = this.getUserState(state, args.userScope);
      userState.runs.unshift(run);
      return run;
    });
  }

  async updateRun(
    userScope: string,
    runId: string,
    patch: Partial<StoredRunRecord>
  ): Promise<StoredRunRecord> {
    return this.enqueueMutation(async (state) => {
      const run = this.requireRun(state, userScope, runId);
      Object.assign(run, patch, { updatedAt: Date.now() });
      return run;
    });
  }

  async getRun(userScope: string, runId: string): Promise<StoredRunRecord | null> {
    const state = await this.loadState();
    const userState = this.getUserState(state, userScope);
    return userState.runs.find((run) => run._id === runId) ?? null;
  }

  async listRuns(userScope: string, limit = 20): Promise<StoredRunRecord[]> {
    const state = await this.loadState();
    const userState = this.getUserState(state, userScope);
    const boundedLimit = Math.max(1, Math.min(100, Math.round(limit)));
    return [...userState.runs]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, boundedLimit);
  }

  async listRecoverableManagedRuns(limit = 50): Promise<StoredRunRecord[]> {
    const state = await this.loadState();
    const boundedLimit = Math.max(1, Math.min(200, Math.round(limit)));
    const runs = Object.values(state.users)
      .flatMap((userState) => userState.runs)
      .filter(
        (run) =>
          run.status === "executing" &&
          (typeof run.workflowId === "string" ||
            typeof run.workflowRunId === "string")
      )
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return runs.slice(0, boundedLimit);
  }

  async createApproval(args: {
    userScope: string;
    runId: string;
    approvalKind: string;
    title: string;
    reason?: string;
    payload?: Record<string, unknown>;
  }): Promise<StoredApprovalRecord> {
    return this.enqueueMutation(async (state) => {
      const approval: StoredApprovalRecord = {
        _id: createId("approval"),
        userScope: args.userScope,
        runId: args.runId,
        approvalKind: args.approvalKind,
        title: args.title,
        status: "pending",
        createdAt: Date.now(),
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.payload ? { payload: args.payload } : {}),
      };
      const userState = this.getUserState(state, args.userScope);
      userState.approvals.unshift(approval);
      return approval;
    });
  }

  async getApproval(
    userScope: string,
    approvalId: string
  ): Promise<StoredApprovalRecord | null> {
    const state = await this.loadState();
    const userState = this.getUserState(state, userScope);
    return userState.approvals.find((approval) => approval._id === approvalId) ?? null;
  }

  async updateApproval(
    userScope: string,
    approvalId: string,
    patch: Partial<StoredApprovalRecord>
  ): Promise<StoredApprovalRecord> {
    return this.enqueueMutation(async (state) => {
      const approval = this.requireApproval(state, userScope, approvalId);
      Object.assign(approval, patch);
      return approval;
    });
  }

  async getAllUserScopes(): Promise<string[]> {
    const state = await this.loadState();
    return Object.keys(state.users);
  }

  async updateRunTask(
    userScope: string,
    runId: string,
    taskIndex: number,
    patch: Partial<LocalCompanionRunTask>
  ): Promise<void> {
    await this.enqueueMutation(async (state) => {
      const run = this.requireRun(state, userScope, runId);
      if (!run.tasks || taskIndex < 0 || taskIndex >= run.tasks.length) {
        return;
      }
      Object.assign(run.tasks[taskIndex], patch, { updatedAt: Date.now() });
      run.updatedAt = Date.now();
    });
  }

  async updateRunProgress(
    userScope: string,
    runId: string,
    progressPatch: Partial<LocalCompanionRunProgress>
  ): Promise<void> {
    await this.enqueueMutation(async (state) => {
      const run = this.requireRun(state, userScope, runId);
      run.progress = { ...(run.progress ?? {
        totalTasks: 0,
        completedTasks: 0,
        skippedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
        currentTaskIndex: 0,
      }), ...progressPatch };
      run.updatedAt = Date.now();
    });
  }

  async incrementCompletedTasks(userScope: string, runId: string): Promise<void> {
    await this.enqueueMutation(async (state) => {
      const run = this.requireRun(state, userScope, runId);
      if (run.progress) {
        run.progress.completedTasks = (run.progress.completedTasks ?? 0) + 1;
      }
      run.updatedAt = Date.now();
    });
  }

  private async loadState(): Promise<StoredState> {
    if (this.cachedState) {
      return this.cachedState;
    }

    if (this.loadStatePromise) {
      return this.loadStatePromise;
    }

    this.loadStatePromise = (async () => {
      try {
        const raw = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as StoredState;
        this.cachedState = parsed?.version === 1 ? parsed : createEmptyState();
      } catch {
        this.cachedState = createEmptyState();
      } finally {
        this.loadStatePromise = null;
      }

      return this.cachedState;
    })();

    return this.loadStatePromise;
  }

  private async writeState(state: StoredState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async enqueueMutation<TResult>(
    mutator: (state: StoredState) => Promise<TResult> | TResult
  ): Promise<TResult> {
    const operation = async () => {
      const state = await this.loadState();
      const result = await mutator(state);
      await this.writeState(state);
      return result;
    };
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private getUserState(state: StoredState, userScope: string): StoredUserState {
    if (!state.users[userScope]) {
      state.users[userScope] = {
        runs: [],
        approvals: [],
      };
    }
    return state.users[userScope];
  }

  private requireRun(
    state: StoredState,
    userScope: string,
    runId: string
  ): StoredRunRecord {
    const run = this.getUserState(state, userScope).runs.find(
      (candidate) => candidate._id === runId
    );
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private requireApproval(
    state: StoredState,
    userScope: string,
    approvalId: string
  ): StoredApprovalRecord {
    const approval = this.getUserState(state, userScope).approvals.find(
      (candidate) => candidate._id === approvalId
    );
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    return approval;
  }
}
