import { describe, expect, test, vi } from "vitest";
import {
  buildDefaultAgentGoal,
  fetchAgentPanelState,
  formatAgentRunStatus,
  getAgentPanelPollMs,
  getAgentRunSummary,
  normalizeAgentGoal,
  resolveAgentApproval,
  startAgentRun,
  summarizeApprovalPayload,
} from "../../../src/lib/agent-panel-runtime.ts";

describe("agent panel runtime helpers", () => {
  test("builds LinkedIn-specific default goals", () => {
    expect(
      buildDefaultAgentGoal(
        "linkedin",
        "https://www.linkedin.com/search/results/people/?keywords=recruiter"
      )
    ).toContain("visible LinkedIn profiles");

    expect(
      buildDefaultAgentGoal(
        "linkedin",
        "https://www.linkedin.com/in/example-person/"
      )
    ).toContain("connection request");

    expect(
      buildDefaultAgentGoal("general", "https://example.com")
    ).toContain("Inspect this page");

    expect(
      buildDefaultAgentGoal("gmail", "https://mail.google.com/mail/u/0/#inbox")
    ).toContain("email thread");

    expect(
      buildDefaultAgentGoal("slack", "https://app.slack.com/client/T1/C1")
    ).toContain("conversation");
  });

  test("uses slower polling when the document is hidden", () => {
    expect(getAgentPanelPollMs(false)).toBe(5_000);
    expect(getAgentPanelPollMs(true)).toBe(15_000);
  });

  test("normalizes agent goals before start", () => {
    expect(normalizeAgentGoal("  Find   recruiters   here  ")).toBe(
      "Find recruiters here"
    );
  });

  test("formats known run statuses", () => {
    expect(formatAgentRunStatus("awaiting_approval")).toBe("Awaiting approval");
    expect(formatAgentRunStatus("executing")).toBe("Executing");
    expect(formatAgentRunStatus("completed")).toBe("Completed");
  });

  test("prefers latest summary or error when summarizing a run card", () => {
    expect(
      getAgentRunSummary({
        _id: "run-1",
        goal: "Inspect",
        status: "completed",
        latestSummary: "Finished safely.",
        createdAt: 0,
        updatedAt: 0,
      })
    ).toBe("Finished safely.");

    expect(
      getAgentRunSummary({
        _id: "run-2",
        goal: "Inspect",
        status: "failed",
        lastError: "Selector not found",
        createdAt: 0,
        updatedAt: 0,
      })
    ).toBe("Selector not found");
  });

  test("summarizes approval payloads from generated text or targets", () => {
    expect(
      summarizeApprovalPayload({
        items: [
          { targetName: "Carolyn Wilmes Orr" },
          { targetName: "Taylor Recruiter" },
          { targetName: "Jordan Hiring" },
          { targetName: "Fourth Person" },
        ],
      })
    ).toContain("Targets (4): Carolyn Wilmes Orr, Taylor Recruiter, Jordan Hiring +1 more");
    expect(
      summarizeApprovalPayload({
        items: [
          {
            targetName: "Carolyn Wilmes Orr",
            generatedText: "Hi Carolyn, I came across your profile and wanted to connect.",
          },
        ],
      })
    ).toContain("Hi Carolyn");
    expect(
      summarizeApprovalPayload({
        generatedText: "Hello there",
        targetName: "Ignored",
      })
    ).toBe("Hello there");
    expect(summarizeApprovalPayload({ targetName: "Carolyn" })).toBe(
      "Target: Carolyn"
    );
    expect(
      summarizeApprovalPayload({
        targetUrl: "https://www.linkedin.com/in/example",
      })
    ).toContain("Target URL");
  });

  test("fetches agent panel state from runtime messaging", async () => {
    const sendMessage = vi.fn(async () => ({
      authenticated: true,
      approvals: [{ _id: "approval-1", title: "Approve this", status: "pending" }],
      runs: [{ _id: "run-1", goal: "Inspect", status: "planning" }],
      runtime: "local_companion",
      runtimeConnected: true,
    }));

    const state = await fetchAgentPanelState(sendMessage, 7);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "GET_AGENT_PANEL_STATE",
      payload: { limit: 7 },
    });
    expect(state.authenticated).toBe(true);
    expect(state.approvals).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runtime).toBe("local_companion");
    expect(state.runtimeConnected).toBe(true);
  });

  test("startAgentRun forwards the current goal and validates the response", async () => {
    const sendMessage = vi.fn(async () => ({
      runId: "run-1",
      runtimeId: "companion-run-1",
    }));

    const result = await startAgentRun(sendMessage, {
      goal: "  Connect   with this recruiter  ",
      platformHint: "linkedin",
      pageUrl: "https://www.linkedin.com/in/example-recruiter/",
      pageContext: "Audience: Carolyn Wilmes Orr",
      fieldTarget: {
        selector: "#composer",
        platform: "linkedin",
        fieldType: "[DM_MESSAGE]",
        charLimit: 300,
      },
      scannedCandidates: [
        {
          targetName: "Carolyn Wilmes Orr",
          targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
          headline: "Principal Engineering Recruiter",
        },
      ],
      nextPageUrl:
        "https://www.linkedin.com/search/results/people/?page=2&keywords=recruiter",
      structured: {
        data: {
          title: "Carolyn Wilmes Orr",
        },
        headings: ["Carolyn Wilmes Orr"],
      },
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "START_AGENT_RUN",
      payload: {
        goal: "Connect with this recruiter",
        platformHint: "linkedin",
        pageUrl: "https://www.linkedin.com/in/example-recruiter/",
        pageContext: "Audience: Carolyn Wilmes Orr",
        fieldTarget: {
          selector: "#composer",
          platform: "linkedin",
          fieldType: "[DM_MESSAGE]",
          charLimit: 300,
        },
        scannedCandidates: [
          {
            targetName: "Carolyn Wilmes Orr",
            targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
            headline: "Principal Engineering Recruiter",
          },
        ],
        nextPageUrl:
          "https://www.linkedin.com/search/results/people/?page=2&keywords=recruiter",
        structured: {
          data: {
            title: "Carolyn Wilmes Orr",
          },
          headings: ["Carolyn Wilmes Orr"],
        },
      },
    });
    expect(result).toEqual({
      runId: "run-1",
      runtimeId: "companion-run-1",
    });
  });

  test("resolveAgentApproval forwards the approval decision", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      status: "approved",
    }));

    const result = await resolveAgentApproval(sendMessage, {
      approvalId: "approval-1",
      decision: "approved",
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "RESOLVE_AGENT_APPROVAL",
      payload: {
        approvalId: "approval-1",
        decision: "approved",
      },
    });
    expect(result).toEqual({ ok: true, status: "approved" });
  });

  test("throws runtime errors from the background bridge", async () => {
    const sendMessage = vi.fn(async () => ({
      error: "Unauthenticated",
    }));

    await expect(fetchAgentPanelState(sendMessage)).rejects.toThrow(
      "Unauthenticated"
    );
  });

  test("throws before sending a start message for empty goals", async () => {
    const sendMessage = vi.fn();
    await expect(
      startAgentRun(sendMessage as any, {
        goal: "   ",
        platformHint: "general",
      })
    ).rejects.toThrow("Goal is required");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
