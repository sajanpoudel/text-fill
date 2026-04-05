import { afterEach, describe, expect, test, vi } from "vitest";
import { callProvider, resolveApiKey } from "../../convex/llmProvider";

describe("llmProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("resolveApiKey selects the configured provider key", () => {
    expect(
      resolveApiKey({
        provider: "anthropic",
        anthropicKey: "anthropic-test-key",
      })
    ).toEqual({
      provider: "anthropic",
      apiKey: "anthropic-test-key",
    });

    expect(
      resolveApiKey({
        provider: "gemini",
        geminiKey: "gemini-test-key",
      })
    ).toEqual({
      provider: "gemini",
      apiKey: "gemini-test-key",
    });
  });

  test("callProvider parses OpenAI output_text responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: "Structured planner draft output",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const text = await callProvider({
      provider: "openai",
      model: "gpt-5-nano",
      apiKey: "test-key",
      system: "system",
      user: "user",
    });

    expect(text).toBe("Structured planner draft output");
  });

  test("callProvider parses OpenAI message-part fallback responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "First line",
                  },
                  {
                    type: "output_text",
                    text: "Second line",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const text = await callProvider({
      provider: "openai",
      model: "gpt-5-nano",
      apiKey: "test-key",
      system: "system",
      user: "user",
    });

    expect(text).toBe("First line\nSecond line");
  });
});
