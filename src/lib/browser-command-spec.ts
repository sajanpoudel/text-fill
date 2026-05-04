import type {
  BrowserCommand,
  BrowserExecutionWorld,
} from "./browser-executor.ts";
import {
  executeLinkedInConnectFromMoreMenuInPage,
  executeLinkedInConnectPrimaryActionInPage,
  executeLinkedInFillAndSendConnectDialogInPage,
} from "./browser-control.ts";

type LocalRunScriptCommand = Extract<BrowserCommand<any>, { kind: "run_script" }>;
type NonScriptBrowserCommand = Exclude<BrowserCommand<any>, { kind: "run_script" }>;

export type BrowserScriptKey =
  | "linkedin_connect_primary_action"
  | "linkedin_connect_from_more_menu"
  | "linkedin_fill_and_send_connect_dialog";

export type SerializableRunScriptCommand = Omit<
  LocalRunScriptCommand,
  "func"
> & {
  scriptKey: BrowserScriptKey;
};

export type SerializableBrowserCommand =
  | NonScriptBrowserCommand
  | SerializableRunScriptCommand;

export type BrowserCommandEnvelope =
  | {
      runId: string;
      stepId: string;
      commandId: string;
      deliveryScope: "specific_tab";
      targetTabId: number;
      completionEventId: string;
      command: SerializableBrowserCommand;
    }
  | {
      runId: string;
      stepId: string;
      commandId: string;
      deliveryScope: "any_attached_tab";
      targetUrl?: string;
      completionEventId: string;
      command: SerializableBrowserCommand;
    };

export function materializeBrowserCommand(
  command: SerializableBrowserCommand
): BrowserCommand<any> {
  if (command.kind !== "run_script") {
    return command;
  }

  return {
    kind: "run_script",
    tabId: command.tabId,
    args: command.args,
    world: command.world,
    func: getBrowserScript(command.scriptKey),
  };
}

export function commandEnvelopeTargetsTab(
  envelope: BrowserCommandEnvelope,
  tabId: number,
  pageUrl?: string | null
): boolean {
  if (envelope.deliveryScope === "specific_tab") {
    return envelope.targetTabId === tabId;
  }

  if (!envelope.targetUrl) {
    return true;
  }

  return urlsMatchForCommandRouting(pageUrl, envelope.targetUrl);
}

export function urlsMatchForCommandRouting(
  pageUrl: string | null | undefined,
  targetUrl: string
): boolean {
  if (!pageUrl) return false;

  try {
    const current = new URL(pageUrl);
    const target = new URL(targetUrl);
    if (current.href === target.href) return true;
    if (current.origin !== target.origin) return false;
    return current.pathname.startsWith(target.pathname);
  } catch {
    return pageUrl === targetUrl;
  }
}

function getBrowserScript(
  scriptKey: BrowserScriptKey
): LocalRunScriptCommand["func"] {
  switch (scriptKey) {
    case "linkedin_connect_primary_action":
      return executeLinkedInConnectPrimaryActionInPage;
    case "linkedin_connect_from_more_menu":
      return executeLinkedInConnectFromMoreMenuInPage;
    case "linkedin_fill_and_send_connect_dialog":
      return executeLinkedInFillAndSendConnectDialogInPage;
  }
}

export function makeSerializableRunScriptCommand(
  tabId: number,
  scriptKey: BrowserScriptKey,
  args: unknown[] = [],
  world: BrowserExecutionWorld = "MAIN"
): SerializableRunScriptCommand {
  return {
    kind: "run_script",
    tabId,
    scriptKey,
    args,
    world,
  };
}
