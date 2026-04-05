/** Context about the field and its recipient, extracted by a platform-specific extractor. */
export interface FieldContext {
  /** Platform-specific field type tag, e.g. "[CONNECTION_NOTE_300]", "[DM_MESSAGE]" */
  fieldType: string | null;
  /** Name of the person being written to */
  recipientName: string | null;
  /** Headline or current role of the recipient */
  recipientRole: string | null;
  /** Structured profile text about the recipient (multi-line) */
  profileContext: string | null;
  /** Supplemental non-profile context gathered by the platform extractor */
  extraContext?: string | null;
  /** Detected character limit for this field, if known */
  charLimit: number | null;
}

export const EMPTY_CONTEXT: FieldContext = {
  fieldType: null,
  recipientName: null,
  recipientRole: null,
  profileContext: null,
  extraContext: null,
  charLimit: null,
};

/**
 * Platform-specific extractor.
 * Implement this for platforms that need custom DOM handling beyond the generic walker.
 * The generic DOM walker (dom/walker.ts) is always used as a fallback/supplement.
 */
export interface PlatformExtractor {
  /** The platform key this extractor handles (matches PlatformKey) */
  readonly key: string;

  /**
   * Returns the tightest compose boundary for this platform.
   * The boundary scopes the DOM walk so irrelevant content (other threads,
   * other conversations) is excluded.
   * If not implemented, the generic ARIA-based findContextBoundary() is used.
   */
  getComposeBoundary?(field: Element): Element;

  /**
   * Extracts recipient, profile, and field-type context for the field.
   * dialogRoot is the nearest [role="dialog"] ancestor, or null.
   * composeBoundary is the result of getComposeBoundary (or generic fallback).
   */
  extractFieldContext(
    field: Element,
    dialogRoot: Element | null,
    composeBoundary: Element,
  ): FieldContext;
}
