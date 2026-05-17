import { describe, expect, test } from "vitest";
import {
  InvalidCompanionRequestError,
  parseRequestEnvelope,
} from "../../companion/server.ts";

describe("parseRequestEnvelope", () => {
  test("parses a valid start_run request without unsafe coercion", () => {
    expect(
      parseRequestEnvelope({
        type: "request",
        requestId: "req_123",
        method: "start_run",
        params: {
          userScope: "user_1",
          goal: "Draft a reply",
          platformHint: "linkedin",
          pageUrl: "https://www.linkedin.com/in/example",
          fieldTarget: {
            selector: "[contenteditable='true']",
            platform: "linkedin",
            charLimit: 300,
          },
          scannedCandidates: [
            {
              targetName: "Taylor Recruiter",
              targetUrl: "https://www.linkedin.com/in/taylor-recruiter",
            },
          ],
          workItems: [
            {
              title: "Handle Taylor Recruiter",
              targetUrl: "https://www.linkedin.com/in/taylor-recruiter",
              sourceType: "scanned_candidate",
            },
          ],
          structured: {
            data: { company: "OpenAI" },
            matchedFields: ["company"],
          },
          providerConfig: {
            provider: "openai",
            apiKey: "test-key",
            model: "gpt-5-mini",
          },
          resumeFile: {
            name: "resume.pdf",
            mimeType: "application/pdf",
            base64: "cGRm",
          },
          nextPageUrl: null,
        },
      })
    ).toEqual({
      type: "request",
      requestId: "req_123",
      method: "start_run",
      params: {
        userScope: "user_1",
        goal: "Draft a reply",
        platformHint: "linkedin",
        pageUrl: "https://www.linkedin.com/in/example",
        fieldTarget: {
          selector: "[contenteditable='true']",
          platform: "linkedin",
          charLimit: 300,
        },
        scannedCandidates: [
          {
            targetName: "Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter",
          },
        ],
        workItems: [
          {
            title: "Handle Taylor Recruiter",
            targetUrl: "https://www.linkedin.com/in/taylor-recruiter",
            sourceType: "scanned_candidate",
          },
        ],
        structured: {
          data: { company: "OpenAI" },
          matchedFields: ["company"],
        },
        providerConfig: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-mini",
        },
        resumeFile: {
          name: "resume.pdf",
          mimeType: "application/pdf",
          base64: "cGRm",
        },
        nextPageUrl: null,
      },
    });
  });

  test("rejects malformed params instead of coercing them into strings", () => {
    expect(() =>
      parseRequestEnvelope({
        type: "request",
        requestId: "req_123",
        method: "cancel_run",
        params: {
          userScope: { tenant: "wrong" },
          runId: "run_123",
        },
      })
    ).toThrowError(InvalidCompanionRequestError);
    expect(() =>
      parseRequestEnvelope({
        type: "request",
        requestId: "req_124",
        method: "get_panel_state",
        params: {
          userScope: "user_1",
          limit: "5",
        },
      })
    ).toThrowError("limit must be a finite number.");
  });

  test("rejects unsupported methods", () => {
    expect(() =>
      parseRequestEnvelope({
        type: "request",
        requestId: "req_125",
        method: "delete_everything",
      })
    ).toThrowError("method is not supported.");
  });
});
