import { describe, expect, test } from "vitest";
import {
  mergeCapturedGenerationContexts,
  normalizeCapturedGenerationContexts,
} from "../../../src/lib/captured-contexts.ts";

describe("captured context helpers", () => {
  test("normalizes active captured contexts and derives hostname", () => {
    const result = normalizeCapturedGenerationContexts([
      {
        id: "ctx-1",
        title: "Target role",
        url: "https://example.com/jobs/1",
        text: "Senior platform role",
        time: 123,
        active: true,
      },
      {
        id: "ctx-2",
        url: "https://example.com/jobs/2",
        text: "   ",
        active: true,
      },
      {
        id: "ctx-3",
        url: "https://example.com/jobs/3",
        text: "Ignore me",
        active: false,
      },
    ]);

    expect(result).toEqual([
      {
        id: "ctx-1",
        title: "Target role",
        url: "https://example.com/jobs/1",
        hostname: "example.com",
        text: "Senior platform role",
        time: 123,
        active: true,
      },
    ]);
  });

  test("merges local and backend contexts without duplicates", () => {
    const local = normalizeCapturedGenerationContexts([
      {
        id: "ctx-1",
        title: "Job description",
        url: "https://company.example/jobs/123",
        text: "Backend platform role",
        active: true,
      },
    ]);
    const backend = normalizeCapturedGenerationContexts([
      {
        id: "ctx-1",
        title: "Job description",
        url: "https://company.example/jobs/123",
        text: "Backend platform role",
        isActive: true,
      },
      {
        id: "ctx-2",
        title: "Founder post",
        url: "https://linkedin.com/posts/example",
        text: "We value builders with product sense.",
        capturedAt: 456,
        isActive: true,
      },
    ]);

    const result = mergeCapturedGenerationContexts(local, backend);

    expect(result).toEqual([
      {
        id: "ctx-1",
        title: "Job description",
        url: "https://company.example/jobs/123",
        hostname: "company.example",
        text: "Backend platform role",
        time: undefined,
        active: true,
      },
      {
        id: "ctx-2",
        title: "Founder post",
        url: "https://linkedin.com/posts/example",
        hostname: "linkedin.com",
        text: "We value builders with product sense.",
        time: 456,
        active: true,
      },
    ]);
  });
});
