import {
  executeInsertTextBySelectorInPage,
  executeLinkedInConnectWorkflowInPage,
  executeWaitForLinkedInPrimaryActionsInPage,
  isLinkedInAddNoteText,
  isLinkedInFinalSendText,
  isLinkedInSendText,
} from "../src/lib/browser-control.ts";
import { urlsMatchForCommandRouting } from "../src/lib/browser-command-spec.ts";
import { buildLinkedInCustomInviteUrl } from "../src/lib/linkedin-recipient-profile.ts";
import type { LocalCompanionFieldTarget } from "../src/lib/local-agent-protocol.ts";
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

type LinkedInDomHints = {
  preferredLabels?: string[];
  avoidedLabels?: string[];
};

type LinkedInConnectExecutionOutcome = "sent" | "failed" | "skipped";

type LinkedInConnectExecutionResult = {
  outcome: LinkedInConnectExecutionOutcome;
  finalState: string;
  debugSummary?: string;
  preservedPage: boolean;
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

function buildFunctionSource(
  func: (...args: any[]) => unknown,
  dependencies: Array<(...args: any[]) => unknown> = []
): string {
  const dependencySource = dependencies
    .map((dependency) => `const ${dependency.name} = ${dependency.toString()};`)
    .join("\n");

  return `(...args) => {
${dependencySource}
return (${func.toString()})(...args);
}`;
}

function summarizeLinkedInConnectDebug(result: {
  debug?: {
    primaryButtons?: string[];
    menuOptions?: string[];
    dialogButtons?: string[];
    resolutionPath?: string[];
  };
}): string {
  const parts: string[] = [];
  const primary = result.debug?.primaryButtons?.slice(0, 5).join(", ");
  const menu = result.debug?.menuOptions?.slice(0, 5).join(", ");
  const dialog = result.debug?.dialogButtons?.slice(0, 5).join(", ");
  const path = result.debug?.resolutionPath?.slice(0, 8).join(" -> ");
  if (primary) parts.push(`primary=${primary}`);
  if (menu) parts.push(`menu=${menu}`);
  if (dialog) parts.push(`dialog=${dialog}`);
  if (path) parts.push(`path=${path}`);
  return parts.join(" | ");
}

function shouldRetryLinkedInConnectWithCustomInvite(finalState: string): boolean {
  return (
    finalState === "dialog_not_found" ||
    finalState === "no_connect_control" ||
    finalState === "menu_connect_not_found"
  );
}

function humanDelay(baseMs: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1_000, Math.round(baseMs + z * baseMs * 0.3));
}

function isBackgroundTabLayoutUnavailable(): boolean {
  return (
    document.visibilityState === "hidden" ||
    window.innerWidth === 0 ||
    window.innerHeight === 0
  );
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
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getPythonBridge().catch(() => null);
    if (pythonBridge) {
      return pythonBridge.insertDraft(args);
    }

    const page = await this.findPageByUrl(args.pageUrl);
    if (!page) {
      throw new Error(
        "The approved page is not open in Chrome DevTools MCP. Keep the target page open and try again."
      );
    }

    const inserted = await this.evaluateOnPage<boolean>({
      pageId: page.pageId,
      func: executeInsertTextBySelectorInPage,
      args: [
        args.fieldTarget.selector,
        args.generatedText,
        args.fieldTarget.platform,
      ],
      bringToFront: true,
    });

    if (!inserted) {
      throw new Error("Failed to insert the approved draft into the target field");
    }

    const verified = await this.evaluateOnPage<boolean>({
      pageId: page.pageId,
      func: (
        selector: string,
        expectedText: string
      ) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return false;
        const text =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : element.isContentEditable
              ? element.innerText || element.textContent || ""
              : element.innerText || element.textContent || "";
        const normalize = (value: string) =>
          value.replace(/\s+/g, " ").trim().toLowerCase();
        const haystack = normalize(text);
        const needle = normalize(expectedText);
        return needle.length > 0 && haystack.includes(needle);
      },
      args: [args.fieldTarget.selector, args.verifyText],
      bringToFront: true,
    });

    if (!verified) {
      throw new Error("Inserted draft could not be verified in the target field");
    }

    return {
      summary: args.targetName
        ? `Inserted the approved draft for ${args.targetName}.`
        : "Inserted the approved draft into the active field.",
      metadata: {
        kind: "insert_draft",
        selector: args.fieldTarget.selector,
        pageUrl: args.pageUrl,
      },
    };
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
  }): Promise<{
    summary: string;
    metadata: Record<string, unknown>;
  }> {
    const pythonBridge = await this.getPythonBridge().catch(() => null);
    if (pythonBridge) {
      return pythonBridge.executeLinkedInConnectBatch(args);
    }

    const maxItems = Math.max(
      1,
      Math.min(args.items.length, Math.round(args.dailyLimit || args.items.length))
    );
    const items = args.items.slice(0, maxItems);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const finalStates: string[] = [];

    for (const item of items) {
      const result = await this.executeLinkedInConnectItem(item, {});
      finalStates.push(result.finalState);
      if (result.outcome === "sent") {
        sent += 1;
      } else if (result.outcome === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
      }
      await this.delay(humanDelay(2_200));
    }

    const summary = [
      `LinkedIn connect batch finished for ${items.length} target${items.length === 1 ? "" : "s"}.`,
      `Sent: ${sent}.`,
      skipped > 0 ? `Skipped: ${skipped}.` : null,
      failed > 0 ? `Failed: ${failed}.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      summary,
      metadata: {
        kind: "execute_task_batch",
        batchType: "linkedin_connect",
        itemCount: items.length,
        sent,
        skipped,
        failed,
        finalStates,
      },
    };
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

  private async waitForPageReady(pageId: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const readyState = await this.evaluateOnPage<string>({
        pageId,
        func: () => document.readyState,
      });
      if (readyState === "complete" || readyState === "interactive") {
        return;
      }
      await this.delay(200);
    }
    throw new Error("Timed out waiting for the page to finish loading");
  }

  private async evaluateOnPage<TResult>(args: {
    pageId: number;
    func: (...values: any[]) => unknown;
    dependencies?: Array<(...values: any[]) => unknown>;
    args?: unknown[];
    bringToFront?: boolean;
  }): Promise<TResult> {
    await this.selectPage(args.pageId, args.bringToFront ?? false);
    const result = await this.callTool("evaluate_script", {
      function: buildFunctionSource(args.func, args.dependencies),
      ...(args.args && args.args.length > 0 ? { args: args.args } : {}),
    });
    return parseChromeMcpEvaluateResult<TResult>(result);
  }

  private async executeLinkedInConnectItem(
    item: LinkedInBatchItem,
    domHints: LinkedInDomHints
  ): Promise<LinkedInConnectExecutionResult> {
    const page = await this.openPage({ url: item.targetUrl });
    let preservePage = false;

    try {
      await this.waitForPageReady(page.pageId, 15_000);
      await this.delay(humanDelay(1_200));

      const actionProbe = await this.evaluateOnPage<Awaited<
        ReturnType<typeof executeWaitForLinkedInPrimaryActionsInPage>
      >>({
        pageId: page.pageId,
        func: executeWaitForLinkedInPrimaryActionsInPage,
        args: [9_000, domHints],
      });

      const preflightLabels = Array.isArray(actionProbe?.labels)
        ? actionProbe.labels
        : [];
      if (!actionProbe?.ready) {
        this.logger.warn("[chrome-mcp] linkedin_connect preflight", {
          targetUrl: item.targetUrl,
          targetName: item.targetName,
          labels: preflightLabels.join(", "),
        });
      }

      const message = (item.generatedText ?? "").trim();
      let connectFlow = await this.evaluateOnPage<Awaited<
        ReturnType<typeof executeLinkedInConnectWorkflowInPage>
      >>({
        pageId: page.pageId,
        func: executeLinkedInConnectWorkflowInPage,
        dependencies: [
          isBackgroundTabLayoutUnavailable,
          isLinkedInAddNoteText,
          isLinkedInSendText,
          isLinkedInFinalSendText,
        ],
        args: [message, domHints],
      });

      let finalState = String(connectFlow?.state ?? "dialog_not_found");
      if (shouldRetryLinkedInConnectWithCustomInvite(finalState)) {
        const customInviteUrl = buildLinkedInCustomInviteUrl(item.targetUrl);
        if (customInviteUrl) {
          this.logger.warn("[chrome-mcp] linkedin_connect custom_invite_retry", {
            targetUrl: item.targetUrl,
            targetName: item.targetName,
            initialState: finalState,
            customInviteUrl,
          });
          await this.navigatePage(page.pageId, customInviteUrl);
          await this.delay(humanDelay(900));
          connectFlow = await this.evaluateOnPage<Awaited<
            ReturnType<typeof executeLinkedInConnectWorkflowInPage>
          >>({
            pageId: page.pageId,
            func: executeLinkedInConnectWorkflowInPage,
            dependencies: [
              isBackgroundTabLayoutUnavailable,
              isLinkedInAddNoteText,
              isLinkedInSendText,
              isLinkedInFinalSendText,
            ],
            args: [message, domHints],
          });
          finalState = String(connectFlow?.state ?? "dialog_not_found");
        }
      }

      const debugSummary =
        summarizeLinkedInConnectDebug(connectFlow ?? {}) ||
        (preflightLabels.length > 0
          ? `preflight=${preflightLabels.slice(0, 8).join(", ")}`
          : undefined);

      this.logger.warn("[chrome-mcp] linkedin_connect", {
        targetUrl: item.targetUrl,
        targetName: item.targetName,
        finalState,
        debugSummary,
      });

      if (finalState === "already_connected" || finalState === "already_pending") {
        return {
          outcome: "skipped",
          finalState,
          debugSummary,
          preservedPage: false,
        };
      }

      if (finalState === "sent") {
        return {
          outcome: "sent",
          finalState,
          debugSummary,
          preservedPage: false,
        };
      }

      preservePage =
        finalState === "dialog_not_found" ||
        finalState === "note_editor_not_found" ||
        finalState === "send_not_found";
      if (preservePage) {
        this.logger.warn("[chrome-mcp] linkedin_connect preserved_page", {
          targetUrl: item.targetUrl,
          targetName: item.targetName,
          finalState,
        });
      }

      return {
        outcome:
          finalState === "no_connect_control" ||
          finalState === "menu_connect_not_found"
            ? "skipped"
            : "failed",
        finalState,
        debugSummary,
        preservedPage: preservePage,
      };
    } finally {
      if (!preservePage) {
        await this.closePage(page.pageId).catch(() => {});
      }
    }
  }

  private async delay(durationMs: number): Promise<void> {
    await this.sleep(durationMs);
  }
}

export {
  buildChromeDevtoolsMcpArgs,
  buildFunctionSource,
  getChromeMcpText,
  parseChromeMcpEvaluateResult,
  parseChromeMcpPageList,
};
