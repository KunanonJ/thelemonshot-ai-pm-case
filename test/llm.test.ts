import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callJson, DEFAULT_MODEL, isWorkersAiModel } from "../src/worker/core/llm";

// The Workers AI path of callJson, with a stand-in AI binding. Call logging writes to D1, which isn't
// here; it's best-effort by design, so its error is silenced rather than faked.
const schema = z.object({ sum: z.number() });
const request = {
  product: "matrix" as const,
  promptVersion: "test",
  system: "Reply with JSON.",
  user: "2 + 3",
  schema,
  jsonSchema: { name: "answer", schema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] } },
  timeoutMs: 1_000,
};
const chat = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

function envWith(run?: (model: string, input: Record<string, unknown>) => Promise<unknown>, model?: string) {
  return {
    CONFIG: { get: async (k: string) => (k === "llm:model" ? (model ?? null) : null) },
    DB: {},
    ...(run ? { AI: { run: vi.fn(run) } } : {}),
  } as unknown as Env & { AI: { run: ReturnType<typeof vi.fn> } };
}

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("Workers AI model calls", () => {
  it("is the default provider", () => {
    expect(isWorkersAiModel(DEFAULT_MODEL)).toBe(true);
    expect(isWorkersAiModel("claude-sonnet-5-5")).toBe(false);
  });

  it("sends the schema and low reasoning effort, and reads the OpenAI-shaped answer", async () => {
    const env = envWith(async () => chat('{"sum": 5}'));
    const res = await callJson(env, request);
    expect(res).toEqual({ ok: true, data: { sum: 5 }, model: DEFAULT_MODEL });
    const [model, input] = env.AI.run.mock.calls[0]!;
    expect(model).toBe(DEFAULT_MODEL);
    expect(input).toMatchObject({ reasoning_effort: "low", response_format: { type: "json_schema" } });
    expect(input).not.toHaveProperty("model");
  });

  it("steps down to prompt-only JSON when the schema is refused", async () => {
    const env = envWith(async (_m, input) => {
      if (input.response_format) throw new Error("AiError: invalid input: response_format not supported");
      return chat('```json\n{"sum": 5}\n```');
    });
    expect(await callJson(env, request)).toMatchObject({ ok: true, data: { sum: 5 } });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a failure that isn't about the request's shape", async () => {
    const env = envWith(async () => {
      throw new Error("AiError: capacity temporarily exceeded");
    });
    expect(await callJson(env, request)).toMatchObject({ ok: false, reason: "http_error" });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("times out instead of waiting forever", async () => {
    const env = envWith(() => new Promise(() => undefined));
    expect(await callJson(env, request)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports a missing binding as not configured", async () => {
    expect(await callJson(envWith(), request)).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("flags an answer that doesn't match the schema", async () => {
    const env = envWith(async () => chat('{"total": 5}'));
    expect(await callJson(env, request)).toMatchObject({ ok: false, reason: "schema_mismatch" });
  });
});
