import {
  executeClickElementBySelectorInPage,
  executeElementExistsInPage,
  executeTypeIntoFieldBySelectorInPage,
} from "./browser-control.ts";

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
  | { kind: "run_script"; tabId: number; result: T };

type BrowserTabsApi = Pick<
  typeof chrome.tabs,
  "create" | "get" | "remove" | "update"
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
                    : TCommand extends BrowserRunScriptCommand<infer TResult>
                      ? { kind: "run_script"; tabId: number; result: TResult }
                      : never;

export interface BrowserExecutor {
  execute<TCommand extends BrowserCommand<any>>(
    command: TCommand
  ): Promise<BrowserCommandResultFor<TCommand>>;
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
    const [result] = await this.api.scripting.executeScript({
      target: { tabId: command.tabId },
      world: command.world,
      func: command.func,
      args: command.args,
    });
    return result?.result as T;
  }

  private async wait(durationMs: number) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}
