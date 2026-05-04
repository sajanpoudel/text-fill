import { extractPageContext } from "./context.ts";
import { createSelectorForElement } from "./browser-control.ts";
import { EMPTY_CONTEXT } from "./platforms/base.ts";
import { getPlatformExtractor } from "./platforms/index.ts";
import type { PlatformKey } from "./platform.ts";

export type AgentFieldTarget = {
  selector: string;
  platform?: string;
  fieldType?: string;
  charLimit?: number;
};

export type AgentRunStartContext = {
  pageContext: string;
  fieldTarget: AgentFieldTarget;
};

export function buildAgentRunStartContext(
  field: Element,
  platform: PlatformKey
): AgentRunStartContext {
  const extractor = getPlatformExtractor(platform);
  const composeBoundary =
    extractor?.getComposeBoundary?.(field) ?? field;
  const dialogRoot =
    field.closest?.("dialog, [role='dialog']") ?? null;
  const fieldContext =
    extractor?.extractFieldContext(field, dialogRoot, composeBoundary) ??
    EMPTY_CONTEXT;

  return {
    pageContext: extractPageContext(field),
    fieldTarget: {
      selector: createSelectorForElement(field),
      platform,
      ...(fieldContext.fieldType ? { fieldType: fieldContext.fieldType } : {}),
      ...(typeof fieldContext.charLimit === "number"
        ? { charLimit: fieldContext.charLimit }
        : {}),
    },
  };
}
