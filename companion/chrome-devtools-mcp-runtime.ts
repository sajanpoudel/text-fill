import { urlsMatchForCommandRouting } from "../src/lib/browser-command-spec.ts";
import type {
  LocalCompanionBrowserWorkItem,
  LocalCompanionCandidateScanItem,
  LocalCompanionFieldTarget,
  LocalCompanionProviderConfig,
  ResumeFileData,
  LocalCompanionStructuredExtraction,
} from "../src/lib/local-agent-protocol.ts";
import {
  createMcpAgentBridgeConnection,
  type ChromeDevtoolsMcpConnection,
  type ChromeMcpToolResult,
  type ConsoleLike,
} from "./mcp-agent-bridge.ts";
import {
  createPythonBrowserRuntimeConnection,
  type PythonBrowserRuntimeConnection,
} from "./python-browser-runtime-bridge.ts";

export interface ChromeDevtoolsMcpPage {
  pageId: number;
  url: string;
  selected: boolean;
}

export interface ChromeDevtoolsMcpRuntimeOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger?: ConsoleLike;
  connectionFactory?: () => Promise<ChromeDevtoolsMcpConnection>;
  pythonBridgeFactory?: (() => Promise<PythonBrowserRuntimeConnection>) | null;
  sleep?: (durationMs: number) => Promise<void>;
}

type LinkedInBatchItem = {
  targetUrl: string;
  targetName?: string;
  generatedText?: string;
};

function normalizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("DevToolsActivePort")) {
    return [
      "Chrome DevTools MCP could not attach to your running Chrome profile.",
      "Chrome is running, but remote debugging is not enabled for the default profile.",
      "Open chrome://inspect/#remote-debugging in Chrome, enable remote debugging, and allow incoming debugging connections.",
      "Then reload the extension and try again.",
      "Alternative: start Chrome with --remote-debugging-port=9222 and set CHROME_DEVTOOLS_MCP_BROWSER_URL=http://127.0.0.1:9222.",
    ].join(" ");
  }

  if (
    (message.includes("127.0.0.1:9222") || message.includes("localhost:9222")) &&
    (message.includes("ECONNREFUSED") ||
      message.includes("Failed to fetch browser webSocket URL") ||
      message.includes("Could not connect to browser"))
  ) {
    return [
      "Chrome DevTools MCP could not reach the configured remote-debugging endpoint.",
      "Start Chrome with --remote-debugging-port=9222 first, or remove CHROME_DEVTOOLS_MCP_BROWSER_URL so the runtime can use --autoConnect instead.",
    ].join(" ");
  }

  return message;
}

function buildChromeDevtoolsMcpArgs(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const args = ["-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"];

  if (
    typeof env.CHROME_DEVTOOLS_MCP_BROWSER_URL === "string" &&
    env.CHROME_DEVTOOLS_MCP_BROWSER_URL.trim()
  ) {
    args.push(`--browser-url=${env.CHROME_DEVTOOLS_MCP_BROWSER_URL.trim()}`);
  } else if (env.CHROME_DEVTOOLS_MCP_AUTO_CONNECT !== "0") {
    args.push("--autoConnect");
  }

  if (env.CHROME_DEVTOOLS_MCP_HEADLESS === "1") {
    args.push("--headless");
  }
  if (env.CHROME_DEVTOOLS_MCP_ISOLATED === "1") {
    args.push("--isolated");
  }
  if (
    typeof env.CHROME_DEVTOOLS_MCP_CHANNEL === "string" &&
    env.CHROME_DEVTOOLS_MCP_CHANNEL.trim()
  ) {
    args.push(`--channel=${env.CHROME_DEVTOOLS_MCP_CHANNEL.trim()}`);
  }
  if (
    typeof env.CHROME_DEVTOOLS_MCP_USER_DATA_DIR === "string" &&
    env.CHROME_DEVTOOLS_MCP_USER_DATA_DIR.trim()
  ) {
    args.push(`--userDataDir=${env.CHROME_DEVTOOLS_MCP_USER_DATA_DIR.trim()}`);
  }

  return args;
}

async function createDefaultChromeDevtoolsMcpConnection(
  options: Required<Pick<ChromeDevtoolsMcpRuntimeOptions, "command" | "args" | "cwd" | "logger">> &
    Partial<Pick<ChromeDevtoolsMcpRuntimeOptions, "env">>
): Promise<ChromeDevtoolsMcpConnection> {
  return createMcpAgentBridgeConnection({
    cwd: options.cwd,
    env: {
      ...(options.env ?? {}),
      CHROME_DEVTOOLS_MCP_COMMAND: options.command,
      CHROME_DEVTOOLS_MCP_ARGS_JSON: JSON.stringify(options.args),
      MCP_AGENT_BRIDGE_CWD: options.cwd,
    },
    logger: options.logger,
  });
}

function getChromeMcpText(result: ChromeMcpToolResult): string {
  return (result.content ?? [])
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function assertChromeMcpToolOk(result: ChromeMcpToolResult, toolName: string): void {
  if (result.isError) {
    const text = getChromeMcpText(result).trim();
    throw new Error(text || `Chrome DevTools MCP tool failed: ${toolName}`);
  }
}

function parseChromeMcpPageList(text: string): ChromeDevtoolsMcpPage[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+:\s+/u.test(line))
    .map((line) => {
      const match = line.match(/^(\d+):\s+(.+?)(\s+\[selected\])?$/u);
      if (!match) {
        return null;
      }
      return {
        pageId: Number(match[1]),
        url: match[2].trim(),
        selected: Boolean(match[3]),
      };
    })
    .filter((page): page is ChromeDevtoolsMcpPage => page !== null);
}

function parseChromeMcpEvaluateResult<T>(result: ChromeMcpToolResult): T {
  if (result.structuredContent && "result" in result.structuredContent) {
    return result.structuredContent.result as T;
  }

  const text = getChromeMcpText(result);
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/u);
  const jsonText = fencedMatch?.[1]?.trim();
  if (jsonText) {
    return JSON.parse(jsonText) as T;
  }

  const fallbackMatch = text.match(/returned:\s*([\s\S]+)$/u);
  const fallbackJson = fallbackMatch?.[1]?.trim();
  if (fallbackJson) {
    return JSON.parse(fallbackJson) as T;
  }

  throw new Error("Chrome DevTools MCP returned an unreadable script result");
}

export class ChromeDevtoolsMcpRuntime {
  private readonly logger: ConsoleLike;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env?: Record<string, string>;
  private readonly connectionFactory?: () => Promise<ChromeDevtoolsMcpConnection>;
  private readonly pythonBridgeFactory?: (() => Promise<PythonBrowserRuntimeConnection>) | null;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private connectionPromise: Promise<ChromeDevtoolsMcpConnection> | null = null;
  private pythonBridgePromise: Promise<PythonBrowserRuntimeConnection> | null = null;
  private lastHealthCheck:
    | {
        checkedAt: number;
        connected: boolean;
        error?: string;
      }
    | null = null;

  constructor(options: ChromeDevtoolsMcpRuntimeOptions = {}) {
    this.logger = options.logger ?? console;
    this.command = options.command ?? "npx";
    this.args = options.args ?? buildChromeDevtoolsMcpArgs(process.env);
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env;
    this.connectionFactory = options.connectionFactory;
    this.pythonBridgeFactory =
      options.pythonBridgeFactory !== undefined
        ? options.pythonBridgeFactory
        : this.connectionFactory
          ? null
          : () =>
              createPythonBrowserRuntimeConnection({
                cwd: this.cwd,
                env: {
                  ...(this.env ?? {}),
                  CHROME_DEVTOOLS_MCP_COMMAND: this.command,
                  CHROME_DEVTOOLS_MCP_ARGS_JSON: JSON.stringify(this.args),
                  MCP_AGENT_BRIDGE_CWD: this.cwd,
                },
                logger: this.logger,
              });
    this.sleep =
      options.sleep ??
      ((durationMs) =>
        new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  async checkAvailability(): Promise<{ connected: boolean; error?: string }> {
    const pythonBridge = await this.getPythonBridge().catch(() => null);
    if (pythonBridge) {
      try {
        const health = await pythonBridge.health();
        return health.connected
          ? health
          : {
              connected: false,
              ...(health.error
                ? { error: normalizeErrorMessage(health.error) }
                : {}),
            };
      } catch (error) {
        return {
          connected: false,
          error: normalizeErrorMessage(error),
        };
      }
    }

    const now = Date.now();
    if (this.lastHealthCheck) {
      const maxAgeMs = this.lastHealthCheck.connected ? 3_000 : 15_000;
      if (now - this.lastHealthCheck.checkedAt < maxAgeMs) {
        return {
          connected: this.lastHealthCheck.connected,
          ...(this.lastHealthCheck.error
            ? { error: this.lastHealthCheck.error }
            : {}),
        };
      }
    }

    try {
      await this.listPages();
      this.lastHealthCheck = {
        checkedAt: now,
        connected: true,
      };
      return { connected: true };
    } catch (error) {
      const health = {
        checkedAt: now,
        connected: false,
        error: normalizeErrorMessage(error),
      };
      this.lastHealthCheck = health;
      return health;
    }
  }

  async insertDraft(args: {
    pageUrl: string;
    fieldTarget: LocalCompanionFieldTarget;
    generatedText: string;
    verifyText: string;
    targetName?: string;
    providerConfig: LocalCompanionProviderConfig;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getRequiredPythonBridge();
    return pythonBridge.insertDraft(args);
  }

  async navigateToUrl(args: {
    targetUrl: string;
    currentPageUrl?: string;
    targetLabel?: string;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getPythonBridge().catch(() => null);
    if (pythonBridge) {
      return pythonBridge.navigateToUrl(args);
    }

    const currentPage =
      typeof args.currentPageUrl === "string" && args.currentPageUrl.trim()
        ? await this.findPageByUrl(args.currentPageUrl.trim())
        : null;

    if (currentPage) {
      await this.navigatePage(currentPage.pageId, args.targetUrl);
      await this.waitForPageReady(currentPage.pageId, 15_000);
      return {
        summary: args.targetLabel
          ? `Opened LinkedIn search results for ${args.targetLabel}.`
          : "Opened the requested page.",
        metadata: {
          kind: "navigate_to_url",
          pageId: currentPage.pageId,
          targetUrl: args.targetUrl,
          reusedPage: true,
        },
      };
    }

    const existingTargetPage = await this.findPageByUrl(args.targetUrl);
    if (existingTargetPage) {
      await this.selectPage(existingTargetPage.pageId, true);
      return {
        summary: args.targetLabel
          ? `Focused LinkedIn search results for ${args.targetLabel}.`
          : "Focused the requested page.",
        metadata: {
          kind: "navigate_to_url",
          pageId: existingTargetPage.pageId,
          targetUrl: args.targetUrl,
          reusedPage: true,
        },
      };
    }

    const page = await this.openPage({ url: args.targetUrl });
    await this.waitForPageReady(page.pageId, 15_000);
    return {
      summary: args.targetLabel
        ? `Opened LinkedIn search results for ${args.targetLabel}.`
        : "Opened the requested page.",
      metadata: {
        kind: "navigate_to_url",
        pageId: page.pageId,
        targetUrl: args.targetUrl,
        reusedPage: false,
      },
    };
  }

  async executeLinkedInConnectBatch(args: {
    items: LinkedInBatchItem[];
    dailyLimit: number;
    providerConfig: LocalCompanionProviderConfig;
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getRequiredPythonBridge();
    return pythonBridge.executeLinkedInConnectBatch(args);
  }

  async executeAgentTask(args: {
    providerConfig: LocalCompanionProviderConfig;
    goal: string;
    runId?: string;
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
    resumeFile?: ResumeFileData | null;
  }, signal?: AbortSignal): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getRequiredPythonBridge();
    return pythonBridge.executeAgentTask(args, signal);
  }

  killPythonBridge(): void {
    if (!this.pythonBridgePromise) return;
    void this.pythonBridgePromise
      .then((bridge) => bridge.close())
      .catch(() => undefined);
    this.pythonBridgePromise = null;
    this.lastHealthCheck = null;
  }

  async registerProgressHandler(
    runId: string,
    callback: (event: Record<string, unknown>) => void
  ): Promise<void> {
    const pythonBridge = await this.getPythonBridge().catch(() => null);
    pythonBridge?.registerProgressHandler(runId, callback);
  }

  unregisterProgressHandler(runId: string): void {
    void this.getPythonBridge().then((bridge) => {
      bridge?.unregisterProgressHandler(runId);
    }).catch(() => undefined);
  }

  async deriveBrowserWorkItems(args: {
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
  }): Promise<{
    mode: "single" | "queue";
    summary: string;
    workItems: LocalCompanionBrowserWorkItem[];
  }> {
    const pythonBridge = await this.getRequiredPythonBridge();
    return pythonBridge.deriveBrowserWorkItems(args);
  }

  async dispose(): Promise<void> {
    if (this.pythonBridgePromise) {
      try {
        const bridge = await this.pythonBridgePromise;
        await bridge.close();
      } finally {
        this.pythonBridgePromise = null;
        this.lastHealthCheck = null;
      }
    }

    if (!this.connectionPromise) {
      return;
    }
    try {
      const connection = await this.connectionPromise;
      await connection.close();
    } finally {
      this.connectionPromise = null;
      this.lastHealthCheck = null;
    }
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  private async getConnection(): Promise<ChromeDevtoolsMcpConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = (this.connectionFactory
        ? this.connectionFactory()
        : createDefaultChromeDevtoolsMcpConnection({
            command: this.command,
            args: this.args,
            cwd: this.cwd,
            env: this.env,
            logger: this.logger,
          })).catch((error) => {
        this.connectionPromise = null;
        throw error;
      });
    }
    return this.connectionPromise;
  }

  private async getPythonBridge(): Promise<PythonBrowserRuntimeConnection | null> {
    if (!this.pythonBridgeFactory) {
      return null;
    }
    if (!this.pythonBridgePromise) {
      this.pythonBridgePromise = this.pythonBridgeFactory().catch((error) => {
        this.pythonBridgePromise = null;
        throw error;
      });
    }
    return this.pythonBridgePromise;
  }

  private async getRequiredPythonBridge(): Promise<PythonBrowserRuntimeConnection> {
    const pythonBridge = await this.getPythonBridge();
    if (!pythonBridge) {
      throw new Error(
        "The Python mcp-agent browser runtime is required for Chrome control, but it is not available."
      );
    }
    return pythonBridge;
  }

  private async callTool(
    name: string,
    args?: Record<string, unknown>
  ): Promise<ChromeMcpToolResult> {
    const connection = await this.getConnection();
    const result = await connection.callTool(name, args ?? {});
    assertChromeMcpToolOk(result, name);
    return result;
  }

  private async listPages(): Promise<ChromeDevtoolsMcpPage[]> {
    const result = await this.callTool("list_pages");
    return parseChromeMcpPageList(getChromeMcpText(result));
  }

  private async selectPage(
    pageId: number,
    bringToFront = false
  ): Promise<void> {
    await this.callTool("select_page", {
      pageId,
      ...(bringToFront ? { bringToFront: true } : {}),
    });
  }

  private async findPageByUrl(
    pageUrl: string
  ): Promise<ChromeDevtoolsMcpPage | null> {
    const pages = await this.listPages();
    return (
      pages.find((page) => page.url === pageUrl) ??
      pages.find((page) => urlsMatchForCommandRouting(page.url, pageUrl)) ??
      null
    );
  }

  private async openPage(args: {
    url: string;
    background?: boolean;
  }): Promise<ChromeDevtoolsMcpPage> {
    const before = await this.listPages();
    const beforePageIds = new Set(before.map((page) => page.pageId));
    const result = await this.callTool("new_page", {
      url: args.url,
      ...(args.background ? { background: true } : {}),
    });
    const pages = parseChromeMcpPageList(getChromeMcpText(result));
    const createdPage =
      pages.find((page) => !beforePageIds.has(page.pageId)) ??
      pages.find((page) => page.selected && page.url === args.url) ??
      pages.find((page) => page.url === args.url) ??
      pages.at(-1);
    if (!createdPage) {
      throw new Error("Chrome DevTools MCP did not report the opened page");
    }
    return createdPage;
  }

  private async navigatePage(pageId: number, url: string): Promise<void> {
    await this.selectPage(pageId, true);
    await this.callTool("navigate_page", {
      type: "url",
      url,
      timeout: 15_000,
    });
  }

  private async closePage(pageId: number): Promise<void> {
    await this.callTool("close_page", { pageId });
  }

  private async evaluateOnPage<TResult>(args: {
    pageId: number;
    functionSource: string;
    runtimeArgs?: unknown[];
    bringToFront?: boolean;
  }): Promise<TResult> {
    await this.selectPage(args.pageId, args.bringToFront ?? false);
    const result = await this.callTool("evaluate_script", {
      function: args.functionSource,
      ...(args.runtimeArgs && args.runtimeArgs.length > 0
        ? { args: args.runtimeArgs }
        : {}),
    });
    return parseChromeMcpEvaluateResult<TResult>(result);
  }

  private async waitForPageReady(pageId: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const readyState = await this.evaluateOnPage<string>({
        pageId,
        functionSource: "() => document.readyState",
      });
      if (readyState === "complete" || readyState === "interactive") {
        return;
      }
      await this.delay(200);
    }
    throw new Error("Timed out waiting for the page to finish loading");
  }
  private async delay(durationMs: number): Promise<void> {
    await this.sleep(durationMs);
  }
}

export {
  buildChromeDevtoolsMcpArgs,
  getChromeMcpText,
  parseChromeMcpEvaluateResult,
  parseChromeMcpPageList,
};
