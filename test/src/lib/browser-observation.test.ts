import { describe, expect, test } from "vitest";
import {
  projectStructuredDataFromSnapshot,
  type StructuredDataSnapshot,
} from "../../../src/lib/browser-observation.ts";

describe("browser observation helpers", () => {
  test("projects structured data from field matches before falling back to text", () => {
    const snapshot: StructuredDataSnapshot = {
      text: "Location: Cincinnati, Ohio Recruiter focus: Software engineering",
      headings: ["Senior Engineering Recruiter"],
      fields: [
        {
          selector: 'input[name="fullName"]',
          tag: "input",
          type: "text",
          label: "Full name",
          value: "Taylor Recruiter",
        },
        {
          selector: 'input[name="email"]',
          tag: "input",
          type: "email",
          label: "Email",
          value: "taylor@example.com",
        },
        {
          selector: 'input[name="remote"]',
          tag: "input",
          type: "checkbox",
          label: "Remote",
          value: true,
        },
      ],
      interactives: [],
    };

    const result = projectStructuredDataFromSnapshot(
      snapshot,
      JSON.stringify({
        type: "object",
        properties: {
          fullName: { type: "string" },
          email: { type: "string" },
          remote: { type: "boolean" },
          location: { type: "string" },
        },
      })
    );

    expect(result.data).toEqual({
      fullName: "Taylor Recruiter",
      email: "taylor@example.com",
      remote: true,
      location: "Cincinnati, Ohio Recruiter focus: Software engineering",
    });
    expect(result.matchedFields).toContain("fullName");
    expect(result.unmatchedFields).toEqual([]);
  });

  test("falls back to headings and summary when structured fields are absent", () => {
    const snapshot: StructuredDataSnapshot = {
      text: "A focused summary about recruiting for backend teams.",
      headings: ["Lead Recruiter"],
      fields: [],
      interactives: [],
    };

    const result = projectStructuredDataFromSnapshot(
      snapshot,
      JSON.stringify({
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          company: { type: "string" },
        },
      })
    );

    expect(result.data.headline).toBe("Lead Recruiter");
    expect(result.data.summary).toBe(
      "A focused summary about recruiting for backend teams."
    );
    expect(result.data.company).toBeNull();
    expect(result.unmatchedFields).toEqual(["company"]);
  });

  test("tolerates invalid schemas and returns an empty projected object", () => {
    const snapshot: StructuredDataSnapshot = {
      text: "hello",
      headings: [],
      fields: [],
      interactives: [],
    };

    expect(projectStructuredDataFromSnapshot(snapshot, "{invalid")).toEqual({
      data: {},
      matchedFields: [],
      unmatchedFields: [],
      headings: [],
      text: "hello",
    });
  });
});
