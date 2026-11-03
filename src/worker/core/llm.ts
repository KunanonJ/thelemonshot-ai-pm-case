import type { z } from "zod";
import { getDb } from "./db/client";
import { llmCalls, type Product } from "./db/schema";
import { errorMessage, localOverride, readSecret } from "./env";
import { fetchWithRetry, isTimeout } from "./http";
import { newId } from "./util";

// FR-CORE-14: the only module that talks to a model. OpenCode Console's OpenAI-compatible endpoint
// translates for non-OpenAI models, so Claude is reachable through it.
const CHAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
// USD per million tokens, from OpenCode Console's pricing table (2 Nov 2026)
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
};
export const FORCE_FAIL_FLAG = "test:llm-force-fail";

export type LlmFailure =
  | "not_configured"
  | "forced_failure"
  | "http_error"
  | "invalid_json"
  | "schema_mismatch"
  | "timeout"
  | "network"
  | "unexpected";

export type LlmResult<T> = { ok: true; data: T; model: string } | { ok: false; reason: LlmFailure; model: string };

export type JsonCallRequest<T> = {
  product: Product;
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchema: { name: string; schema: Record<string, unknown> };
  runId?: string;
  maxTokens?: number;
  timeoutMs?: number;
};

type Mode = "json_schema" | "prompt_only" | "none";

// FR-CORE-15/16/18: strict JSON in, schema-validated out, every call logged. Callers get a typed
// failure instead of an exception and switch to their deterministic path, so nothing may throw out of here.
export async function callJson<T>(env: Env, req: JsonCallRequest<T>): Promise<LlmResult<T>> {
  const call: CallState = { model: DEFAULT_MODEL, mode: "none", started: Date.now() };
  const fail: Fail<T> = async (reason, error, usage) => {
    await logCall(env, req, { ...call, status: reason, error, usage });
    return { ok: false, reason, model: call.model };
  };
  try {
    return await requestJson(env, req, call, fail);
  } catch (e) {
    console.error("llm call failed unexpectedly", { product: req.product, runId: req.runId ?? null, error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined });
    return fail("unexpected", errorMessage(e));
  }
}

type CallState = { model: string; mode: Mode; started: number };
type Fail<T> = (reason: LlmFailure, error?: string, usage?: Usage) => Promise<LlmResult<T>>;

async function requestJson<T>(env: Env, req: JsonCallRequest<T>, call: CallState, fail: Fail<T>): Promise<LlmResult<T>> {
  // A KV read that fails means the default model and no test switch, not a failed call
  call.model = (await env.CONFIG.get("llm:model").catch(() => null)) ?? DEFAULT_MODEL;
  if ((await env.CONFIG.get(FORCE_FAIL_FLAG).catch(() => null)) === "1") return fail("forced_failure");
  const apiKey = readSecret(env, "OPENCODE_API_KEY");
  if (!apiKey) return fail("not_configured");

  const base = {
    model: call.model,
    temperature: 0,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  };
  // Prefer schema-enforced output; step down if the gateway rejects a parameter for this model
  const attempts: { mode: Mode; body: Record<string, unknown> }[] = [
    {
      mode: "json_schema",
      body: {
        ...base,
        max_tokens: req.maxTokens ?? 8_000,
        response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } },
      },
    },
    { mode: "prompt_only", body: { ...base, max_tokens: req.maxTokens ?? 8_000 } },
    { mode: "prompt_only", body: base },
  ];

  let res: Response | undefined;
  try {
    for (const attempt of attempts) {
      call.mode = attempt.mode;
      res = await fetchWithRetry(
        chatUrl(env),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body),
        },
        { timeoutMs: req.timeoutMs ?? 120_000, retries: 1 },
      );
      if (res.status !== 400) break;
    }
  } catch (e) {
    return fail(isTimeout(e) ? "timeout" : "network", errorMessage(e));
  }
  if (!res || !res.ok) return fail("http_error", `HTTP ${res?.status}: ${(await res?.text().catch(() => "")) ?? ""}`.slice(0, 300));

  const body = (await res.json().catch(() => null)) as { model?: string; choices?: { message?: { content?: unknown } }[]; usage?: Usage } | null;
  if (!body || typeof body !== "object") return fail("invalid_json", "The response body wasn't a JSON object");
  const content = body.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? parseJsonObject(content) : null;
  if (parsed === null) return fail("invalid_json", undefined, body.usage);
  const validated = req.schema.safeParse(parsed);
  if (!validated.success) return fail("schema_mismatch", validated.error.message.slice(0, 300), body.usage);

  await logCall(env, req, { ...call, status: "ok", usage: body.usage });
  return { ok: true, data: validated.data, model: call.model };
}

const chatUrl = (env: Env) => localOverride(env, "LLM_CHAT_URL", CHAT_URL);

type Usage = { prompt_tokens?: number; completion_tokens?: number };

async function logCall(
  env: Env,
  req: JsonCallRequest<unknown>,
  r: { model: string; mode: Mode; status: LlmFailure | "ok"; started: number; error?: string; usage?: Usage },
): Promise<void> {
  const price = PRICES[r.model];
  const inputTokens = r.usage?.prompt_tokens ?? null;
  const outputTokens = r.usage?.completion_tokens ?? null;
  const costUsd =
    price && inputTokens !== null && outputTokens !== null ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
  // Best-effort: a lost log row must not turn a good answer into a failure
  try {
    await getDb(env)
      .insert(llmCalls)
      .values({
        id: newId(),
        product: req.product,
        promptVersion: req.promptVersion,
        model: r.model,
        mode: r.mode,
        status: r.status,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: Date.now() - r.started,
        runId: req.runId ?? null,
        error: r.error ?? null,
        createdAt: Date.now(),
      });
  } catch (e) {
    console.error("llm call not logged", { product: req.product, runId: req.runId ?? null, status: r.status, costUsd, error: errorMessage(e) });
  }
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
