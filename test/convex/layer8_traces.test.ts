import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const authed = t.withIdentity({ subject: `${userId}|session` });
  return { t, authed, userId };
}

describe("tracing", () => {
  test("getRecentBadCases returns heavily edited and rewritten traces", async () => {
    const { authed, userId } = await setup();
    const sessionId = await authed.run(async (ctx) =>
      ctx.db.insert("interactionSessions", {
        userId: userId as any,
        sessionId: crypto.randomUUID(),
        platform: "linkedin",
        openedAt: Date.now() - 1000,
        closedAt: Date.now(),
        outcome: "rewritten",
        aiGeneratedAt: Date.now() - 500,
      })
    );

    const traceId = await authed.mutation(internal.traces.recordTrace, {
      userId: userId as any,
      platform: "linkedin",
      modelId: "gpt-5-nano",
      promptFingerprint: "abc123",
      presentedOutput: "Original generated output",
      hadLiveContext: true,
      retrievedPatternCount: 2,
      episodeExampleCount: 1,
      latencyMs: 1200,
    });

    await authed.mutation(internal.traces.updateOutcome, {
      traceId,
      sessionId,
      userAction: "rewritten",
      editFraction: 0.8,
    });

    const results = await authed.query(api.traces.getRecentBadCases, {});
    expect(results).toHaveLength(1);
    expect(results[0].userAction).toBe("rewritten");
    expect(results[0].editFraction).toBe(0.8);
  });

  test("recordTraceArtifact upserts by trace id", async () => {
    const { authed, userId } = await setup();
    const traceId = await authed.mutation(internal.traces.recordTrace, {
      userId: userId as any,
      platform: "gmail",
      modelId: "gpt-5-nano",
      promptFingerprint: "prompt-1",
      presentedOutput: "hello",
      hadLiveContext: false,
      retrievedPatternCount: 0,
      episodeExampleCount: 0,
      latencyMs: 300,
    });

    const firstArtifact = await authed.mutation(internal.traces.recordTraceArtifact, {
      traceId,
      systemPrompt: "system-1",
      userPrompt: "user-1",
      rawLlmOutput: "raw-1",
    });
    const secondArtifact = await authed.mutation(internal.traces.recordTraceArtifact, {
      traceId,
      systemPrompt: "system-2",
      userPrompt: "user-2",
      rawLlmOutput: "raw-2",
    });

    expect(firstArtifact).toBe(secondArtifact);
    const artifact = (await authed.run((ctx) => ctx.db.get(firstArtifact))) as
      | { systemPrompt?: string }
      | null;
    expect(artifact?.systemPrompt).toBe("system-2");
  });

  test("getTraceStats summarizes recent traces", async () => {
    const { authed, userId } = await setup();
    const firstTrace = await authed.mutation(internal.traces.recordTrace, {
      userId: userId as any,
      platform: "linkedin",
      modelId: "gpt-5-nano",
      promptFingerprint: "p1",
      presentedOutput: "one",
      hadLiveContext: false,
      retrievedPatternCount: 0,
      episodeExampleCount: 0,
      latencyMs: 100,
    });
    const sessionId = await authed.run(async (ctx) =>
      ctx.db.insert("interactionSessions", {
        userId: userId as any,
        sessionId: crypto.randomUUID(),
        platform: "linkedin",
        openedAt: Date.now() - 1000,
        closedAt: Date.now(),
        outcome: "accepted",
        aiGeneratedAt: Date.now() - 500,
      })
    );
    await authed.mutation(internal.traces.updateOutcome, {
      traceId: firstTrace,
      sessionId,
      userAction: "accepted",
      editFraction: 0,
    });
    await authed.mutation(internal.traces.recordTrace, {
      userId: userId as any,
      platform: "gmail",
      modelId: "gpt-5-nano",
      promptFingerprint: "p2",
      presentedOutput: "two",
      hadLiveContext: true,
      retrievedPatternCount: 1,
      episodeExampleCount: 2,
      latencyMs: 300,
    });

    const stats = await authed.query(api.traces.getTraceStats, {});
    expect(stats?.total).toBe(2);
    expect(stats?.withOutcome).toBe(1);
    expect(stats?.avgLatency).toBe(200);
    expect(stats?.outcomes.accepted).toBe(1);
  });

  test("getRecentBadCases caps results at 50 newest traces across bad outcomes", async () => {
    const { authed, userId } = await setup();

    for (let i = 0; i < 55; i += 1) {
      const sessionId = await authed.run(async (ctx) =>
        ctx.db.insert("interactionSessions", {
          userId: userId as any,
          sessionId: crypto.randomUUID(),
          platform: "linkedin",
          openedAt: Date.now() - 10_000 - i,
          closedAt: Date.now() - i,
          outcome: i % 2 === 0 ? "rewritten" : "heavily_edited",
          aiGeneratedAt: Date.now() - 5_000 - i,
        })
      );

      const traceId = await authed.mutation(internal.traces.recordTrace, {
        userId: userId as any,
        platform: "linkedin",
        modelId: "gpt-5-nano",
        promptFingerprint: `trace-${i}`,
        presentedOutput: `output-${i}`,
        hadLiveContext: i % 3 === 0,
        retrievedPatternCount: i % 4,
        episodeExampleCount: i % 2,
        latencyMs: 100 + i,
      });

      await authed.mutation(internal.traces.updateOutcome, {
        traceId,
        sessionId,
        userAction: i % 2 === 0 ? "rewritten" : "heavily_edited",
        editFraction: 0.6,
      });
    }

    const results = await authed.query(api.traces.getRecentBadCases, {});
    expect(results).toHaveLength(50);
    expect(results[0].createdAt).toBeGreaterThanOrEqual(results[49].createdAt);
  });
});
