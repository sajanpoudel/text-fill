import { describe, expect, test } from "vitest";
import {
  applyLinkedInConnectDrafts,
  buildConversationDraftPrompt,
  buildDraftVerificationText,
  buildRollingPlannerSummary,
  buildLinkedInConnectDraftPrompt,
  buildHeuristicLinkedInConnectNote,
  deriveConversationDraftDecision,
  deriveBootstrapPlannerDecision,
  enrichLinkedInSearchBatchItems,
  extractLinkedInSearchNextPageUrl,
  extractLinkedInSearchCandidates,
  inferPlannerPlatformFromUrl,
  isLinkedInConnectIntent,
  isLinkedInProfileContext,
  isLinkedInSearchResultsContext,
  normalizeConversationDraft,
  planLinkedInSearchCollectionPass,
  parseRequestedConnectCount,
  rankLinkedInPlannerBatchItemsForEnrichment,
  shouldUseConversationDraftFlow,
  shouldCheckpointPlannerSummary,
} from "../../../src/lib/agent-planner.ts";

describe("agent planner helpers", () => {
  test("detects LinkedIn connect intent and profile/search contexts", () => {
    expect(isLinkedInConnectIntent("Find this recruiter and send a connection request")).toBe(true);
    expect(isLinkedInConnectIntent("Just inspect the page")).toBe(false);
    expect(
      isLinkedInProfileContext("linkedin", "https://www.linkedin.com/in/example/")
    ).toBe(true);
    expect(
      isLinkedInProfileContext("linkedin", "https://www.linkedin.com/feed/")
    ).toBe(false);
    expect(
      isLinkedInSearchResultsContext(
        "linkedin",
        "https://www.linkedin.com/search/results/people/?keywords=recruiter"
      )
    ).toBe(true);
    expect(
      isLinkedInProfileContext(
        undefined,
        "https://www.linkedin.com/in/example-recruiter/"
      )
    ).toBe(true);
    expect(
      isLinkedInSearchResultsContext(
        undefined,
        "https://www.linkedin.com/search/results/people/?keywords=recruiter"
      )
    ).toBe(true);
    expect(
      inferPlannerPlatformFromUrl("https://mail.google.com/mail/u/0/#inbox")
    ).toBe("gmail");
  });

  test("parses a requested connect count with sane fallback and cap", () => {
    expect(parseRequestedConnectCount("Find 12 software recruiters")).toBe(12);
    expect(parseRequestedConnectCount("Find 200 software recruiters")).toBe(20);
    expect(parseRequestedConnectCount("Find recruiters here")).toBe(5);
  });

  test("builds a bounded heuristic connect note", () => {
    const note = buildHeuristicLinkedInConnectNote(
      "Carolyn Wilmes Orr",
      "Senior Software Engineering Recruiter"
    );
    expect(note).toContain("Hi Carolyn");
    expect(note.length).toBeLessThanOrEqual(300);
  });

  test("builds a structured prompt for model-backed LinkedIn drafts", () => {
    const prompt = buildLinkedInConnectDraftPrompt({
      goal: "Find 2 software engineering recruiters and queue connection requests",
      items: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
          targetHeadline: "Principal Engineering Recruiter",
          generatedText: "Hi Carolyn, I came across your profile and wanted to connect.",
        },
      ],
    });

    expect(prompt.system).toContain("Return JSON only");
    expect(prompt.user).toContain("targetUrl: https://www.linkedin.com/in/carolyn-wilmes-orr/");
    expect(prompt.user).toContain("Principal Engineering Recruiter");
  });

  test("builds and normalizes generic conversation drafts", () => {
    const prompt = buildConversationDraftPrompt({
      goal: "Reply to this recruiter",
      platformHint: "gmail",
      pageContext: "Audience: Taylor Recruiter\nThread context:\nFollowing up on backend hiring.",
      charLimit: 280,
    });

    expect(prompt.system).toContain("280 characters");
    expect(prompt.user).toContain("Taylor Recruiter");
    expect(
      normalizeConversationDraft("  Hi Taylor,\n\nHappy to connect here.  ", 280)
    ).toBe("Hi Taylor,\n\nHappy to connect here.");
    expect(buildDraftVerificationText("Hello there this is a longer draft", 10)).toBe(
      "Hello ther"
    );
  });

  test("detects when a direct conversation draft flow is safe to use", () => {
    expect(
      shouldUseConversationDraftFlow({
        goal: "Draft a reply",
        platformHint: "gmail",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox",
        pageContext: "Audience: Taylor Recruiter",
        fieldTarget: {
          selector: "#composer",
          platform: "gmail",
        },
      })
    ).toBe(true);

    expect(
      shouldUseConversationDraftFlow({
        goal: "Draft a reply",
        pageUrl: "https://mail.google.com/mail/u/0/#inbox",
        pageContext: "Audience: Taylor Recruiter",
        fieldTarget: {
          selector: "#composer",
          platform: "gmail",
        },
      })
    ).toBe(true);

    expect(
      shouldUseConversationDraftFlow({
        goal: "Send a connection request",
        platformHint: "linkedin",
        pageUrl: "https://www.linkedin.com/in/example/",
        pageContext: "Audience: Example",
        fieldTarget: {
          selector: "#composer",
          platform: "linkedin",
        },
      })
    ).toBe(false);
  });

  test("derives an approval-gated conversation draft insert decision", () => {
    const decision = deriveConversationDraftDecision({
      goal: "Reply to this recruiter",
      platformHint: "gmail",
      pageUrl: "https://mail.google.com/mail/u/0/#inbox",
      pageContext:
        "Field: [EMAIL_BODY]\nAudience: Taylor Recruiter\nThread context:\nBackend hiring follow-up.",
      fieldTarget: {
        selector: "#composer",
        platform: "gmail",
        fieldType: "[EMAIL_BODY]",
        charLimit: 1200,
      },
      generatedText: "Hi Taylor,\n\nThanks for following up here.",
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "insert_draft"
    ) {
      throw new Error("Expected request_approval");
    }
    expect(decision.approvalKind).toBe("draft_insert");
    expect(decision.payload.actionType).toBe("insert_draft");
    expect(decision.payload.fieldTarget.selector).toBe("#composer");
    expect(decision.payload.targetName).toBe("Taylor Recruiter");
  });

  test("applies parsed model-backed LinkedIn drafts by target url", () => {
    const applied = applyLinkedInConnectDrafts({
      items: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
          generatedText: "Heuristic note",
        },
        {
          targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          targetName: "Taylor Recruiter",
          generatedText: "Fallback note",
        },
      ],
      responseText: JSON.stringify({
        drafts: [
          {
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            generatedText:
              "Hi Carolyn, your work recruiting for platform engineering stood out to me. I’d love to connect and stay in touch.",
          },
        ],
      }),
    });

    expect(applied.source).toBe("model");
    expect(applied.items[0]?.generatedText).toContain("platform engineering");
    expect(applied.items[1]?.generatedText).toBe("Fallback note");
  });

  test("falls back when the model response does not contain usable JSON drafts", () => {
    const applied = applyLinkedInConnectDrafts({
      items: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
          generatedText: "Heuristic note",
        },
      ],
      responseText: "I think this looks good.",
    });

    expect(applied.source).toBe("heuristic");
    expect(applied.items[0]?.generatedText).toBe("Heuristic note");
  });

  test("enriches shortlisted search batch items with profile observations", () => {
    const enriched = enrichLinkedInSearchBatchItems({
      items: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
          generatedText: "Hi Carolyn, I came across your profile and wanted to connect. I'd love to stay in touch.",
        },
        {
          targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          targetName: "Taylor Recruiter",
          generatedText: "Hi Taylor, I came across your profile and wanted to connect. I'd love to stay in touch.",
        },
      ],
      profileObservations: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          headline: "Principal Engineering Recruiter",
          summary: "Hiring across backend and infrastructure engineering.",
        },
      ],
    });

    expect(enriched[0]?.generatedText?.toLowerCase()).toContain(
      "your work in principal engineering recruiter stood out to me"
    );
    expect(enriched[1]?.generatedText).toContain("Hi Taylor");
  });

  test("ranks planner batch items for enrichment by outreach relevance", () => {
    const ranked = rankLinkedInPlannerBatchItemsForEnrichment({
      goal: "Find software engineering recruiters",
      items: [
        {
          targetUrl: "https://www.linkedin.com/in/generic-recruiter/",
          targetName: "Generic Recruiter",
          targetHeadline: "Recruiter",
        },
        {
          targetUrl: "https://www.linkedin.com/in/engineering-recruiter/",
          targetName: "Engineering Recruiter",
          targetHeadline: "Principal Engineering Recruiter",
        },
      ],
    });

    expect(ranked.map((item) => item.targetName)).toEqual([
      "Engineering Recruiter",
      "Generic Recruiter",
    ]);
  });

  test("builds a rolling planner summary from prior summary and recent steps", () => {
    const summary = buildRollingPlannerSummary({
      goal: "Find recruiters and queue connection requests",
      latestSummary: "Earlier we captured the initial page state.",
      recentSteps: [
        {
          stepIndex: 6,
          role: "browser_result",
          content: "Observed 24 interactive elements on the current page.",
        },
        {
          stepIndex: 7,
          role: "planner",
          content: "Prepare a deterministic handoff from the visible candidate list.",
        },
      ],
    });

    expect(summary).toContain("Earlier progress:");
    expect(summary).toContain("browser result:");
    expect(summary).toContain("planner:");
  });

  test("detects when a planner summary checkpoint is due", () => {
    expect(
      shouldCheckpointPlannerSummary({
        currentStepIndex: 7,
        lastSummarizedAtStep: 0,
      })
    ).toBe(true);
    expect(
      shouldCheckpointPlannerSummary({
        currentStepIndex: 8,
        lastSummarizedAtStep: 6,
      })
    ).toBe(false);
  });

  test("extracts visible LinkedIn search candidates from interactive links", () => {
    const candidates = extractLinkedInSearchCandidates(
      [
        {
          id: "interactive-1",
          selector: 'a[href="/in/carolyn-wilmes-orr/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/carolyn-wilmes-orr/?trk=abc",
          label: "View Carolyn Wilmes Orr's profile",
          text: "Carolyn Wilmes Orr",
          disabled: false,
        },
        {
          id: "interactive-2",
          selector: 'a[href="/in/taylor-recruiter/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/taylor-recruiter/",
          label: null,
          text: "Taylor Recruiter",
          disabled: false,
        },
        {
          id: "interactive-3",
          selector: ".nav-home",
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/feed/",
          label: "Home",
          text: "Home",
          disabled: false,
        },
      ],
      10
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        targetName: "Carolyn Wilmes Orr",
        generatedText: expect.stringContaining("Hi Carolyn"),
      }),
      expect.objectContaining({
        targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
        targetName: "Taylor Recruiter",
        generatedText: expect.stringContaining("Hi Taylor"),
      }),
    ]);
  });

  test("extracts the next LinkedIn search results page url from interactive links", () => {
    const nextPageUrl = extractLinkedInSearchNextPageUrl(
      [
        {
          id: "interactive-1",
          selector: ".pagination-next",
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2",
          label: "Next",
          text: "Next",
          disabled: false,
        },
      ],
      "https://www.linkedin.com/search/results/people/?keywords=recruiter"
    );

    expect(nextPageUrl).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2"
    );
  });

  test("plans another LinkedIn search collection pass when more pages are needed", () => {
    const decision = planLinkedInSearchCollectionPass({
      goal: "Find 4 software recruiters",
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
      accumulatedItems: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
        },
      ],
      scannedCandidates: [
        {
          targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
          targetName: "Taylor Recruiter",
        },
      ],
      nextPageUrl:
        "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2",
    });

    expect(decision.kind).toBe("collect_more");
    if (decision.kind !== "collect_more") {
      throw new Error("Expected collect_more decision");
    }
    expect(decision.accumulatedItems).toHaveLength(2);
    expect(decision.nextPageUrl).toContain("page=2");
    expect(decision.accumulatedItems[1]?.generatedText).toContain("Hi Taylor");
  });

  test("filters scanned search candidates to recruiter profiles that match the requested focus", () => {
    const decision = planLinkedInSearchCollectionPass({
      goal: "Find 3 software engineering recruiters",
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
      scannedCandidates: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
          headline: "Principal Engineering Recruiter",
        },
        {
          targetUrl: "https://www.linkedin.com/in/sales-recruiter/",
          targetName: "Sales Recruiter",
          headline: "Enterprise Sales Recruiter",
        },
        {
          targetUrl: "https://www.linkedin.com/in/software-engineer/",
          targetName: "Software Engineer",
          headline: "Senior Software Engineer",
        },
      ],
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.payload.items).toHaveLength(1);
    expect(decision.payload.items[0]?.targetName).toBe("Carolyn Wilmes Orr");
  });

  test("orders structured search candidates by outreach relevance before approval", () => {
    const decision = planLinkedInSearchCollectionPass({
      goal: "Find 2 software engineering recruiters",
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
      scannedCandidates: [
        {
          targetUrl: "https://www.linkedin.com/in/generic-recruiter/",
          targetName: "Generic Recruiter",
          headline: "Recruiter",
        },
        {
          targetUrl: "https://www.linkedin.com/in/engineering-recruiter/",
          targetName: "Engineering Recruiter",
          headline: "Principal Engineering Recruiter",
        },
        {
          targetUrl: "https://www.linkedin.com/in/technical-recruiter/",
          targetName: "Technical Recruiter",
          headline: "Senior Technical Recruiter",
        },
      ],
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.payload.items.map((item) => item.targetName)).toEqual([
      "Engineering Recruiter",
      "Technical Recruiter",
    ]);
  });

  test("falls back to interactive parsing when structured search scan data is unavailable", () => {
    const decision = planLinkedInSearchCollectionPass({
      goal: "Find 4 software recruiters",
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
      accumulatedItems: [
        {
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          targetName: "Carolyn Wilmes Orr",
        },
      ],
      interactiveElements: [
        {
          id: "interactive-1",
          selector: 'a[href="/in/taylor-recruiter/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/taylor-recruiter/",
          label: null,
          text: "Taylor Recruiter",
          disabled: false,
        },
        {
          id: "interactive-2",
          selector: ".pagination-next",
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2",
          label: "Next",
          text: "Next",
          disabled: false,
        },
      ],
    });

    expect(decision.kind).toBe("collect_more");
    if (decision.kind !== "collect_more") {
      throw new Error("Expected collect_more decision");
    }
    expect(decision.accumulatedItems).toHaveLength(2);
    expect(decision.nextPageUrl).toContain("page=2");
    expect(decision.accumulatedItems[1]?.generatedText).toContain("Hi Taylor");
  });

  test("derives approval-gated connect handoff for LinkedIn profile goals", () => {
    const decision = deriveBootstrapPlannerDecision({
      goal: "Connect with this recruiter after review",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
      structured: {
        data: {
          title: "Carolyn Wilmes Orr",
          headline: "Senior Software Engineering Recruiter",
        },
        headings: ["Carolyn Wilmes Orr"],
        text: "Senior Software Engineering Recruiter",
      },
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.payload.batchType).toBe("linkedin_connect");
    expect(decision.payload.items).toHaveLength(1);
    expect(decision.payload.items[0]?.targetName).toBe("Carolyn Wilmes Orr");
    expect(decision.generatedText?.length ?? 0).toBeLessThanOrEqual(300);
  });

  test("derives a LinkedIn profile connect handoff from the profile url when structured data is empty", () => {
    const decision = deriveBootstrapPlannerDecision({
      goal: "Queue a connection request for this LinkedIn profile after approval.",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/in/gianna-satriano-a467a0228/",
      structured: {
        data: {
          title: null,
          headline: null,
          summary: null,
        },
        matchedFields: [],
        unmatchedFields: ["title", "headline", "summary"],
        headings: [],
        text: "",
      },
      interactiveElements: [],
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.payload.batchType).toBe("linkedin_connect");
    expect(decision.payload.items).toHaveLength(1);
    expect(decision.payload.items[0]?.targetName).toBe("Gianna Satriano");
    expect(decision.payload.items[0]?.targetUrl).toBe(
      "https://www.linkedin.com/in/gianna-satriano-a467a0228/"
    );
  });

  test("derives a LinkedIn profile connect handoff from the profile url without an explicit platform hint", () => {
    const decision = deriveBootstrapPlannerDecision({
      goal: "Queue a connection request for this LinkedIn profile after approval.",
      pageUrl: "https://www.linkedin.com/in/gianna-satriano-a467a0228/",
      structured: {
        data: {
          title: null,
          headline: null,
          summary: null,
        },
        matchedFields: [],
        unmatchedFields: ["title", "headline", "summary"],
        headings: [],
        text: "",
      },
      interactiveElements: [],
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.payload.items[0]?.targetName).toBe("Gianna Satriano");
  });

  test("derives multi-target approval-gated connect handoff for LinkedIn search goals", () => {
    const decision = deriveBootstrapPlannerDecision({
      goal: "Find 3 software engineering recruiters and queue connection requests",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=software%20recruiter",
      interactiveElements: [
        {
          id: "interactive-1",
          selector: 'a[href="/in/carolyn-wilmes-orr/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          label: null,
          text: "Carolyn Wilmes Orr",
          disabled: false,
        },
        {
          id: "interactive-2",
          selector: 'a[href="/in/taylor-recruiter/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/taylor-recruiter/",
          label: null,
          text: "Taylor Recruiter",
          disabled: false,
        },
        {
          id: "interactive-3",
          selector: 'a[href="/in/jordan-talent/"]',
          tag: "a",
          role: null,
          type: null,
          href: "https://www.linkedin.com/in/jordan-talent/",
          label: null,
          text: "Jordan Talent",
          disabled: false,
        },
      ],
    });

    expect(decision.kind).toBe("request_approval");
    if (
      decision.kind !== "request_approval" ||
      decision.payload.actionType !== "create_task_batch"
    ) {
      throw new Error("Expected request_approval decision");
    }
    expect(decision.title).toContain("3 LinkedIn connection requests");
    expect(decision.payload.dailyLimit).toBe(3);
    expect(decision.payload.items).toHaveLength(3);
    expect(decision.generatedText).toBeUndefined();
    expect(decision.payload.items.every((item) => !!item.generatedText)).toBe(true);
  });

  test("falls back to a safe completion summary for non-destructive goals", () => {
    const decision = deriveBootstrapPlannerDecision({
      goal: "Inspect the current page and summarize it",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/in/example/",
      structured: {
        data: { title: "Example" },
      },
    });

    expect(decision.kind).toBe("complete");
    if (decision.kind !== "complete") {
      throw new Error("Expected complete decision");
    }
    expect(decision.summary).toContain("safe summary");
  });
});
