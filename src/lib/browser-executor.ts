import {
  executeClickElementBySelectorInPage,
  executeElementExistsInPage,
  executeExtractStructuredDataSnapshotInPage,
  executeExtractTextInPage,
  executeGetAccessibilityTreeInPage,
  executeInsertTextBySelectorInPage,
  executePressKeyInPage,
  executeSetFieldValueBySelectorInPage,
  executeScrollInPage,
  executeSnapshotInteractivesInPage,
  executeTypeIntoFieldBySelectorInPage,
  executeVerifyTextInPage,
  type TextVerificationResult,
} from "./browser-control.ts";
import type {
  AccessibilityNodeSnapshot,
  BrowserObservationScope,
  InteractiveElementSnapshot,
  StructuredDataExtractionResult,
  StructuredDataSnapshot,
} from "./browser-observation.ts";
import { projectStructuredDataFromSnapshot } from "./browser-observation.ts";
import {
  scanLinkedInCandidatesInPage,
  type CandidateScanResult,
} from "./candidate-scan.ts";

export type BrowserExecutionWorld = "ISOLATED" | "MAIN";

export type BrowserCommand<T = unknown> =
  | {
      kind: "open_tab";
      url: string;
      active?: boolean;
    }
  | {
      kind: "close_tab";
      tabId: number;
    }
  | {
      kind: "navigate";
      tabId: number;
      url: string;
      waitForComplete?: boolean;
      timeoutMs?: number;
    }
  | {
      kind: "wait";
      durationMs: number;
    }
  | {
      kind: "wait_for_tab_complete";
      tabId: number;
      timeoutMs?: number;
    }
  | {
      kind: "wait_for_url";
      tabId: number;
      urlIncludes: string;
      timeoutMs?: number;
      intervalMs?: number;
    }
  | {
      kind: "wait_for_element";
      tabId: number;
      selector: string;
      timeoutMs?: number;
      intervalMs?: number;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "click";
      tabId: number;
      selector: string;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "type";
      tabId: number;
      selector: string;
      text: string;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "press_key";
      tabId: number;
      key: string;
      modifiers?: string[];
      selector?: string;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "scroll";
      tabId: number;
      direction: "up" | "down";
      amount?: number;
      selector?: string;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "extract_text";
      tabId: number;
      selector?: string;
      scope?: BrowserObservationScope;
      maxLength?: number;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "verify_text";
      tabId: number;
      expectedText: string;
      selector?: string;
      scope?: BrowserObservationScope;
      caseSensitive?: boolean;
      maxLength?: number;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "take_screenshot";
      tabId: number;
      format?: chrome.extensionTypes.ImageFormat;
    }
  | {
      kind: "snapshot_interactives";
      tabId: number;
      scope?: BrowserObservationScope;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "get_accessibility_tree";
      tabId: number;
      scope?: BrowserObservationScope;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "insert_text";
      tabId: number;
      selector: string;
      text: string;
      platform?: string;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "set_field_value";
      tabId: number;
      selector: string;
      value: string | boolean | string[];
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "extract_structured";
      tabId: number;
      schema: string;
      promptHint?: string;
      scope?: BrowserObservationScope;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "scan_candidates";
      tabId: number;
      platform: "linkedin";
      maxResults?: number;
      world?: BrowserExecutionWorld;
    }
  | {
      kind: "run_script";
      tabId: number;
      func: (...args: any[]) => T;
      args?: unknown[];
      world?: BrowserExecutionWorld;
    };

type BrowserOpenTabCommand = Extract<BrowserCommand, { kind: "open_tab" }>;
type BrowserCloseTabCommand = Extract<BrowserCommand, { kind: "close_tab" }>;
type BrowserNavigateCommand = Extract<BrowserCommand, { kind: "navigate" }>;
type BrowserWaitCommand = Extract<BrowserCommand, { kind: "wait" }>;
type BrowserWaitForTabCompleteCommand = Extract<
  BrowserCommand,
  { kind: "wait_for_tab_complete" }
>;
type BrowserWaitForUrlCommand = Extract<
  BrowserCommand,
  { kind: "wait_for_url" }
>;
type BrowserWaitForElementCommand = Extract<
  BrowserCommand,
  { kind: "wait_for_element" }
>;
type BrowserClickCommand = Extract<BrowserCommand, { kind: "click" }>;
type BrowserTypeCommand = Extract<BrowserCommand, { kind: "type" }>;
type BrowserPressKeyCommand = Extract<BrowserCommand, { kind: "press_key" }>;
type BrowserScrollCommand = Extract<BrowserCommand, { kind: "scroll" }>;
type BrowserExtractTextCommand = Extract<BrowserCommand, { kind: "extract_text" }>;
type BrowserVerifyTextCommand = Extract<BrowserCommand, { kind: "verify_text" }>;
type BrowserTakeScreenshotCommand = Extract<
  BrowserCommand,
  { kind: "take_screenshot" }
>;
type BrowserSnapshotInteractivesCommand = Extract<
  BrowserCommand,
  { kind: "snapshot_interactives" }
>;
type BrowserGetAccessibilityTreeCommand = Extract<
  BrowserCommand,
  { kind: "get_accessibility_tree" }
>;
type BrowserInsertTextCommand = Extract<
  BrowserCommand,
  { kind: "insert_text" }
>;
type BrowserSetFieldValueCommand = Extract<
  BrowserCommand,
  { kind: "set_field_value" }
>;
type BrowserExtractStructuredCommand = Extract<
  BrowserCommand,
  { kind: "extract_structured" }
>;
type BrowserScanCandidatesCommand = Extract<
  BrowserCommand,
  { kind: "scan_candidates" }
>;
type BrowserRunScriptCommand<T> = Extract<BrowserCommand<T>, { kind: "run_script" }>;

type NormalizedBrowserCommand<T = unknown> =
  | (BrowserOpenTabCommand & { active: boolean })
  | BrowserCloseTabCommand
  | (BrowserNavigateCommand & { waitForComplete: boolean; timeoutMs: number })
  | BrowserWaitCommand
  | (BrowserWaitForTabCompleteCommand & { timeoutMs: number })
  | (BrowserWaitForUrlCommand & { timeoutMs: number; intervalMs: number })
  | (BrowserWaitForElementCommand & {
      timeoutMs: number;
      intervalMs: number;
      world: BrowserExecutionWorld;
    })
  | (BrowserClickCommand & { world: BrowserExecutionWorld })
  | (BrowserTypeCommand & { world: BrowserExecutionWorld })
  | (BrowserPressKeyCommand & { modifiers: string[]; world: BrowserExecutionWorld })
  | (BrowserScrollCommand & { amount: number; world: BrowserExecutionWorld })
  | (BrowserExtractTextCommand & {
      scope: BrowserObservationScope;
      maxLength: number;
      world: BrowserExecutionWorld;
    })
  | (BrowserVerifyTextCommand & {
      scope: BrowserObservationScope;
      caseSensitive: boolean;
      maxLength: number;
      world: BrowserExecutionWorld;
    })
  | (BrowserTakeScreenshotCommand & { format: chrome.extensionTypes.ImageFormat })
  | (BrowserSnapshotInteractivesCommand & {
      scope: BrowserObservationScope;
      world: BrowserExecutionWorld;
    })
  | (BrowserGetAccessibilityTreeCommand & {
      scope: BrowserObservationScope;
      world: BrowserExecutionWorld;
    })
  | (BrowserInsertTextCommand & { world: BrowserExecutionWorld })
  | (BrowserSetFieldValueCommand & { world: BrowserExecutionWorld })
  | (BrowserExtractStructuredCommand & {
      scope: BrowserObservationScope;
      world: BrowserExecutionWorld;
    })
  | (BrowserScanCandidatesCommand & {
      maxResults: number;
      world: BrowserExecutionWorld;
    })
  | (BrowserRunScriptCommand<T> & { world: BrowserExecutionWorld; args: unknown[] });

export type BrowserCommandResult<T = unknown> =
  | { kind: "open_tab"; tabId: number; url: string | undefined }
  | { kind: "close_tab"; tabId: number; closed: true }
  | { kind: "navigate"; tabId: number; url: string }
  | { kind: "wait"; waitedMs: number }
  | { kind: "wait_for_tab_complete"; tabId: number; status: "complete" }
  | { kind: "wait_for_url"; tabId: number; url: string }
  | { kind: "wait_for_element"; tabId: number; selector: string; found: true }
  | { kind: "click"; tabId: number; selector: string; clicked: boolean }
  | { kind: "type"; tabId: number; selector: string; typed: boolean }
  | { kind: "press_key"; tabId: number; key: string; pressed: boolean }
  | { kind: "scroll"; tabId: number; deltaY: number; position: number | null }
  | {
      kind: "extract_text";
      tabId: number;
      scope: BrowserObservationScope;
      text: string;
    }
  | {
      kind: "verify_text";
      tabId: number;
      expectedText: string;
      matched: boolean;
      text: string;
    }
  | { kind: "take_screenshot"; tabId: number; imageDataUrl: string }
  | {
      kind: "snapshot_interactives";
      tabId: number;
      scope: BrowserObservationScope;
      elements: InteractiveElementSnapshot[];
    }
  | {
      kind: "get_accessibility_tree";
      tabId: number;
      scope: BrowserObservationScope;
      tree: AccessibilityNodeSnapshot | null;
    }
  | {
      kind: "insert_text";
      tabId: number;
      selector: string;
      inserted: boolean;
    }
  | { kind: "set_field_value"; tabId: number; selector: string; set: boolean }
  | {
      kind: "extract_structured";
      tabId: number;
      scope: BrowserObservationScope;
      result: StructuredDataExtractionResult;
    }
  | {
      kind: "scan_candidates";
      tabId: number;
      platform: "linkedin";
      scan: CandidateScanResult;
    }
  | { kind: "run_script"; tabId: number; result: T };

type BrowserTabsApi = Pick<
  typeof chrome.tabs,
  "captureVisibleTab" | "create" | "get" | "remove" | "update"
> & {
  onUpdated: Pick<typeof chrome.tabs.onUpdated, "addListener" | "removeListener">;
};

type BrowserScriptingApi = Pick<typeof chrome.scripting, "executeScript">;

type ChromeBrowserApi = {
  tabs: BrowserTabsApi;
  scripting: BrowserScriptingApi;
};

const DEFAULT_TAB_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_ELEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_OBSERVATION_SCOPE: BrowserObservationScope = "main";
const DEFAULT_SCROLL_AMOUNT_PX = 640;
const TRANSIENT_SCRIPT_RETRY_LIMIT = 3;
const TRANSIENT_SCRIPT_RETRY_DELAY_MS = 300;

export type BrowserCommandResultFor<TCommand extends BrowserCommand<any>> =
  TCommand extends BrowserOpenTabCommand
    ? Extract<BrowserCommandResult, { kind: "open_tab" }>
    : TCommand extends BrowserCloseTabCommand
      ? Extract<BrowserCommandResult, { kind: "close_tab" }>
      : TCommand extends BrowserNavigateCommand
        ? Extract<BrowserCommandResult, { kind: "navigate" }>
        : TCommand extends BrowserWaitCommand
          ? Extract<BrowserCommandResult, { kind: "wait" }>
          : TCommand extends BrowserWaitForTabCompleteCommand
            ? Extract<BrowserCommandResult, { kind: "wait_for_tab_complete" }>
            : TCommand extends BrowserWaitForUrlCommand
              ? Extract<BrowserCommandResult, { kind: "wait_for_url" }>
              : TCommand extends BrowserWaitForElementCommand
                ? Extract<BrowserCommandResult, { kind: "wait_for_element" }>
                : TCommand extends BrowserClickCommand
                  ? Extract<BrowserCommandResult, { kind: "click" }>
                  : TCommand extends BrowserTypeCommand
                    ? Extract<BrowserCommandResult, { kind: "type" }>
                    : TCommand extends BrowserPressKeyCommand
                      ? Extract<BrowserCommandResult, { kind: "press_key" }>
                      : TCommand extends BrowserScrollCommand
                        ? Extract<BrowserCommandResult, { kind: "scroll" }>
                        : TCommand extends BrowserExtractTextCommand
                          ? Extract<BrowserCommandResult, { kind: "extract_text" }>
                          : TCommand extends BrowserVerifyTextCommand
                            ? Extract<BrowserCommandResult, { kind: "verify_text" }>
                    : TCommand extends BrowserTakeScreenshotCommand
                      ? Extract<BrowserCommandResult, { kind: "take_screenshot" }>
                      : TCommand extends BrowserSnapshotInteractivesCommand
                        ? Extract<
                            BrowserCommandResult,
                            { kind: "snapshot_interactives" }
                          >
                        : TCommand extends BrowserGetAccessibilityTreeCommand
                          ? Extract<
                              BrowserCommandResult,
                              { kind: "get_accessibility_tree" }
                            >
                          : TCommand extends BrowserInsertTextCommand
                            ? Extract<
                                BrowserCommandResult,
                                { kind: "insert_text" }
                              >
                          : TCommand extends BrowserSetFieldValueCommand
                            ? Extract<
                                BrowserCommandResult,
                                { kind: "set_field_value" }
                              >
                            : TCommand extends BrowserExtractStructuredCommand
                              ? Extract<
                                  BrowserCommandResult,
                                  { kind: "extract_structured" }
                                >
                              : TCommand extends BrowserScanCandidatesCommand
                                ? Extract<
                                    BrowserCommandResult,
                                    { kind: "scan_candidates" }
                                  >
                                : TCommand extends BrowserRunScriptCommand<infer TResult>
                                  ? { kind: "run_script"; tabId: number; result: TResult }
                                  : never;

export interface BrowserExecutor {
  execute<TCommand extends BrowserCommand<any>>(
    command: TCommand
  ): Promise<BrowserCommandResultFor<TCommand>>;
}

function isTransientScriptExecutionError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Frame with ID 0 was removed") ||
    message.includes("No frame with id 0") ||
    message.includes("The frame was removed") ||
    message.includes("Cannot access contents of url")
  );
}

export function normalizeBrowserCommand<T = unknown>(
  command: BrowserCommand<T>
): NormalizedBrowserCommand<T> {
  switch (command.kind) {
    case "open_tab":
      return { ...command, active: command.active ?? false };
    case "close_tab":
      return command;
    case "navigate":
      return {
        ...command,
        waitForComplete: command.waitForComplete ?? true,
        timeoutMs: command.timeoutMs ?? DEFAULT_TAB_TIMEOUT_MS,
      };
    case "wait":
      return command;
    case "wait_for_tab_complete":
      return {
        ...command,
        timeoutMs: command.timeoutMs ?? DEFAULT_TAB_TIMEOUT_MS,
      };
    case "wait_for_url":
      return {
        ...command,
        timeoutMs: command.timeoutMs ?? DEFAULT_TAB_TIMEOUT_MS,
        intervalMs: command.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      };
    case "wait_for_element":
      return {
        ...command,
        timeoutMs: command.timeoutMs ?? DEFAULT_ELEMENT_TIMEOUT_MS,
        intervalMs: command.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        world: command.world ?? "ISOLATED",
      };
    case "click":
      return {
        ...command,
        world: command.world ?? "ISOLATED",
      };
    case "type":
      return {
        ...command,
        world: command.world ?? "ISOLATED",
      };
    case "press_key":
      return {
        ...command,
        modifiers: command.modifiers ?? [],
        world: command.world ?? "ISOLATED",
      };
    case "scroll":
      return {
        ...command,
        amount: command.amount ?? DEFAULT_SCROLL_AMOUNT_PX,
        world: command.world ?? "ISOLATED",
      };
    case "extract_text":
      return {
        ...command,
        scope: command.scope ?? DEFAULT_OBSERVATION_SCOPE,
        maxLength: command.maxLength ?? 6000,
        world: command.world ?? "ISOLATED",
      };
    case "verify_text":
      return {
        ...command,
        scope: command.scope ?? DEFAULT_OBSERVATION_SCOPE,
        caseSensitive: command.caseSensitive ?? false,
        maxLength: command.maxLength ?? 6000,
        world: command.world ?? "ISOLATED",
      };
    case "take_screenshot":
      return {
        ...command,
        format: command.format ?? "png",
      };
    case "snapshot_interactives":
      return {
        ...command,
        scope: command.scope ?? DEFAULT_OBSERVATION_SCOPE,
        world: command.world ?? "ISOLATED",
      };
    case "get_accessibility_tree":
      return {
        ...command,
        scope: command.scope ?? DEFAULT_OBSERVATION_SCOPE,
        world: command.world ?? "ISOLATED",
      };
    case "insert_text":
      return {
        ...command,
        world: command.world ?? "ISOLATED",
      };
    case "set_field_value":
      return {
        ...command,
        world: command.world ?? "ISOLATED",
      };
    case "extract_structured":
      return {
        ...command,
        scope: command.scope ?? DEFAULT_OBSERVATION_SCOPE,
        world: command.world ?? "ISOLATED",
      };
    case "scan_candidates":
      return {
        ...command,
        maxResults: command.maxResults ?? 20,
        world: command.world ?? "ISOLATED",
      };
    case "run_script":
      return {
        ...command,
        world: command.world ?? "ISOLATED",
        args: command.args ?? [],
      };
  }
}

export class ChromeBrowserExecutor implements BrowserExecutor {
  constructor(private readonly api: ChromeBrowserApi) {}

  async execute<TCommand extends BrowserCommand<any>>(
    command: TCommand
  ): Promise<BrowserCommandResultFor<TCommand>> {
    const normalized = normalizeBrowserCommand(command);

    switch (normalized.kind) {
      case "open_tab": {
        const tab = await this.api.tabs.create({
          url: normalized.url,
          active: normalized.active,
        });
        return {
          kind: "open_tab",
          tabId: tab.id!,
          url: tab.url,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "close_tab":
        await this.api.tabs.remove(normalized.tabId);
        return {
          kind: "close_tab",
          tabId: normalized.tabId,
          closed: true,
        } as BrowserCommandResultFor<TCommand>;

      case "navigate":
        await this.api.tabs.update(normalized.tabId, { url: normalized.url });
        if (normalized.waitForComplete) {
          await this.waitForTabComplete(
            normalized.tabId,
            normalized.timeoutMs
          );
        }
        return {
          kind: "navigate",
          tabId: normalized.tabId,
          url: normalized.url,
        } as BrowserCommandResultFor<TCommand>;

      case "wait":
        await this.wait(normalized.durationMs);
        return {
          kind: "wait",
          waitedMs: normalized.durationMs,
        } as BrowserCommandResultFor<TCommand>;

      case "wait_for_tab_complete":
        await this.waitForTabComplete(normalized.tabId, normalized.timeoutMs);
        return {
          kind: "wait_for_tab_complete",
          tabId: normalized.tabId,
          status: "complete",
        } as BrowserCommandResultFor<TCommand>;

      case "wait_for_url": {
        const url = await this.waitForUrl(
          normalized.tabId,
          normalized.urlIncludes,
          normalized.timeoutMs,
          normalized.intervalMs
        );
        return {
          kind: "wait_for_url",
          tabId: normalized.tabId,
          url,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "wait_for_element":
        await this.waitForElement(normalized);
        return {
          kind: "wait_for_element",
          tabId: normalized.tabId,
          selector: normalized.selector,
          found: true,
        } as BrowserCommandResultFor<TCommand>;

      case "click": {
        const result = await this.runScript<boolean>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeClickElementBySelectorInPage,
          args: [normalized.selector],
        });
        return {
          kind: "click",
          tabId: normalized.tabId,
          selector: normalized.selector,
          clicked: !!result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "type": {
        const result = await this.runScript<boolean>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeTypeIntoFieldBySelectorInPage,
          args: [normalized.selector, normalized.text],
        });
        return {
          kind: "type",
          tabId: normalized.tabId,
          selector: normalized.selector,
          typed: !!result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "press_key": {
        const result = await this.runScript<boolean>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executePressKeyInPage,
          args: [normalized.key, normalized.modifiers, normalized.selector],
        });
        return {
          kind: "press_key",
          tabId: normalized.tabId,
          key: normalized.key,
          pressed: !!result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "scroll": {
        const result = await this.runScript<{ deltaY: number; position: number | null }>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeScrollInPage,
          args: [normalized.direction, normalized.amount, normalized.selector],
        });
        return {
          kind: "scroll",
          tabId: normalized.tabId,
          deltaY: result.deltaY,
          position: result.position,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "extract_text": {
        const text = await this.runScript<string>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeExtractTextInPage,
          args: [normalized.selector, normalized.scope, normalized.maxLength],
        });
        return {
          kind: "extract_text",
          tabId: normalized.tabId,
          scope: normalized.scope,
          text,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "verify_text": {
        const result = await this.runScript<TextVerificationResult>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeVerifyTextInPage,
          args: [
            normalized.expectedText,
            normalized.selector,
            normalized.scope,
            normalized.caseSensitive,
            normalized.maxLength,
          ],
        });
        return {
          kind: "verify_text",
          tabId: normalized.tabId,
          expectedText: normalized.expectedText,
          matched: result.matched,
          text: result.text,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "take_screenshot": {
        const tab = await this.api.tabs.get(normalized.tabId);
        if (!tab.active) {
          throw new Error(
            "take_screenshot requires the target tab to be active in its window"
          );
        }
        const imageDataUrl = await this.api.tabs.captureVisibleTab(
          tab.windowId,
          { format: normalized.format }
        );
        return {
          kind: "take_screenshot",
          tabId: normalized.tabId,
          imageDataUrl,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "snapshot_interactives": {
        const elements = await this.runScript<InteractiveElementSnapshot[]>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeSnapshotInteractivesInPage,
          args: [normalized.scope],
        });
        return {
          kind: "snapshot_interactives",
          tabId: normalized.tabId,
          scope: normalized.scope,
          elements,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "get_accessibility_tree": {
        const tree = await this.runScript<AccessibilityNodeSnapshot | null>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeGetAccessibilityTreeInPage,
          args: [normalized.scope],
        });
        return {
          kind: "get_accessibility_tree",
          tabId: normalized.tabId,
          scope: normalized.scope,
          tree,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "insert_text": {
        const result = await this.runScript<boolean>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeInsertTextBySelectorInPage,
          args: [normalized.selector, normalized.text, normalized.platform],
        });
        return {
          kind: "insert_text",
          tabId: normalized.tabId,
          selector: normalized.selector,
          inserted: !!result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "set_field_value": {
        const result = await this.runScript<boolean>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeSetFieldValueBySelectorInPage,
          args: [normalized.selector, normalized.value],
        });
        return {
          kind: "set_field_value",
          tabId: normalized.tabId,
          selector: normalized.selector,
          set: !!result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "extract_structured": {
        const snapshot = await this.runScript<StructuredDataSnapshot | null>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: executeExtractStructuredDataSnapshotInPage,
          args: [normalized.scope],
        });
        const result = projectStructuredDataFromSnapshot(
          snapshot,
          normalized.schema,
          normalized.promptHint
        );
        return {
          kind: "extract_structured",
          tabId: normalized.tabId,
          scope: normalized.scope,
          result,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "scan_candidates": {
        const scan = await this.runScript<CandidateScanResult>({
          kind: "run_script",
          tabId: normalized.tabId,
          world: normalized.world,
          func: scanLinkedInCandidatesInPage,
          args: [normalized.maxResults],
        });
        return {
          kind: "scan_candidates",
          tabId: normalized.tabId,
          platform: normalized.platform,
          scan,
        } as BrowserCommandResultFor<TCommand>;
      }

      case "run_script": {
        const result = await this.runScript(normalized);
        return {
          kind: "run_script",
          tabId: normalized.tabId,
          result,
        } as BrowserCommandResultFor<TCommand>;
      }
    }
  }

  async waitForTabComplete(tabId: number, timeoutMs = DEFAULT_TAB_TIMEOUT_MS) {
    const tab = await this.api.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.api.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("tab load timeout"));
      }, timeoutMs);

      const onUpdated = (
        updatedTabId: number,
        info: chrome.tabs.OnUpdatedInfo
      ) => {
        if (updatedTabId === tabId && info.status === "complete") {
          clearTimeout(timeout);
          this.api.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };

      this.api.tabs.onUpdated.addListener(onUpdated);
    });
  }

  private async waitForUrl(
    tabId: number,
    urlIncludes: string,
    timeoutMs: number,
    intervalMs: number
  ) {
    const startedAt = Date.now();

    for (;;) {
      const tab = await this.api.tabs.get(tabId);
      const url = tab.url ?? "";
      if (url.includes(urlIncludes)) return url;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`url wait timeout for ${urlIncludes}`);
      }
      await this.wait(intervalMs);
    }
  }

  private async waitForElement(
    command: Extract<NormalizedBrowserCommand, { kind: "wait_for_element" }>
  ) {
    const startedAt = Date.now();

    for (;;) {
      const exists = await this.runScript<boolean>({
        kind: "run_script",
        tabId: command.tabId,
        world: command.world,
        func: executeElementExistsInPage,
        args: [command.selector],
      });

      if (exists) return;
      if (Date.now() - startedAt >= command.timeoutMs) {
        throw new Error(`element wait timeout for ${command.selector}`);
      }
      await this.wait(command.intervalMs);
    }
  }

  private async runScript<T = unknown>(
    command: Extract<NormalizedBrowserCommand<T>, { kind: "run_script" }>
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < TRANSIENT_SCRIPT_RETRY_LIMIT; attempt += 1) {
      try {
        const [result] = await this.api.scripting.executeScript({
          target: { tabId: command.tabId },
          world: command.world,
          func: command.func,
          args: command.args,
        });
        return result?.result as T;
      } catch (error) {
        lastError = error;
        if (!isTransientScriptExecutionError(error)) {
          throw error;
        }

        if (attempt >= TRANSIENT_SCRIPT_RETRY_LIMIT - 1) {
          break;
        }

        await this.waitForTabComplete(
          command.tabId,
          Math.min(DEFAULT_TAB_TIMEOUT_MS, 5_000)
        ).catch(() => {});
        await this.wait(TRANSIENT_SCRIPT_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    throw lastError;
  }

  private async wait(durationMs: number) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
