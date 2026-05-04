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

  test("resolveApiKey defaults to openai provider when provider is unset", () => {
    expect(resolveApiKey({ openaiKey: "openai-test-key" })).toEqual({
      provider: "openai",
      apiKey: "openai-test-key",
    });
  });

  test("resolveApiKey returns null apiKey when the matching key field is absent", () => {
    expect(resolveApiKey({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
      apiKey: null,
    });
    expect(resolveApiKey({ provider: "gemini" })).toEqual({
      provider: "gemini",
      apiKey: null,
    });
    expect(resolveApiKey({ provider: "openai" })).toEqual({
      provider: "openai",
      apiKey: null,
    });
  });

  test("resolveApiKey treats null profile as openai with no key", () => {
    expect(resolveApiKey(null)).toEqual({
      provider: "openai",
      apiKey: null,
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

  test("callProvider throws on a non-ok OpenAI response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "invalid_api_key" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      callProvider({
        provider: "openai",
        model: "gpt-5-nano",
        apiKey: "bad-key",
        system: "system",
        user: "user",
      })
    ).rejects.toThrow("OpenAI error");
  });

  test("callProvider parses Anthropic responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Anthropic response text" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const text = await callProvider({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      system: "system",
      user: "user",
    });

    expect(text).toBe("Anthropic response text");
  });

  test("callProvider throws on a non-ok Anthropic response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "authentication_error" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      callProvider({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "bad-key",
        system: "system",
        user: "user",
      })
    ).rejects.toThrow("Anthropic error");
  });

  test("callProvider parses Gemini responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Gemini" },
                    { text: " response text" },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const text = await callProvider({
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKey: "test-key",
      system: "system",
      user: "user",
    });

    expect(text).toBe("Gemini response text");
  });

  test("callProvider throws on a non-ok Gemini response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "API_KEY_INVALID" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      callProvider({
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiKey: "bad-key",
        system: "system",
        user: "user",
      })
    ).rejects.toThrow("Gemini error");
  });

  test("callProvider throws when OpenAI response body cannot be parsed into text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ unexpected: "shape" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      callProvider({
        provider: "openai",
        model: "gpt-5-nano",
        apiKey: "test-key",
        system: "system",
        user: "user",
      })
    ).rejects.toThrow("Could not parse OpenAI response");
  });
});
