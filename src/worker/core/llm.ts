import type { z } from "zod";
import { getDb } from "./db/client";
import { llmCalls, type Product } from "./db/schema";
import { errorMessage, localOverride, readSecret } from "./env";
import { fetchWithRetry, isTimeout } from "./http";
import { newId } from "./util";

// FR-CORE-14: the only module that talks to a model. Two providers, picked by the model ID:
// - "@cf/..." runs on Cloudflare Workers AI through the AI binding: 10,000 Neurons a day are free on every
//   Workers plan, which covers the MVP. GLM-5.3-Flash takes the strict JSON schema and answers in Thai and English.
// - anything else goes to OpenCode Console's OpenAI-compatible endpoint, which needs a funded account (its
//   free models only work inside the OpenCode app). An admin can switch with the llm:model setting.
const CHAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
export const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
// USD per million tokens: OpenCode Console's pricing table (2 Nov 2026) and Workers AI's list price beyond the
// free daily Neurons (3 Nov 2026). Inside the free allowance Workers AI costs nothing, so the weekly total overstates.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "glm-5.3-flash": { input: 0.15, output: 0.5 },
  "@cf/zai-org/glm-5.3-flash": { input: 0.15, output: 0.5 },
};

export const isWorkersAiModel = (model: string): boolean => model.startsWith("@cf/");

// Workers AI needs only the binding; OpenCode needs its key
export function modelConfigured(env: Env, model: string): boolean {
  return isWorkersAiModel(model) ? Boolean(env.AI) : Boolean(readSecret(env, "OPENCODE_API_KEY"));
}

// The admin's llm:model setting, else the default. A KV read that fails means the default.
export async function activeModel(env: Env): Promise<string> {
  return (await env.CONFIG.get("llm:model").catch(() => null)) ?? DEFAULT_MODEL;
}
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
  call.model = await activeModel(env);
  if ((await env.CONFIG.get(FORCE_FAIL_FLAG).catch(() => null)) === "1") return fail("forced_failure");
  if (!modelConfigured(env, call.model)) return fail("not_configured");
  const timeoutMs = req.timeoutMs ?? 120_000;

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

  let reply: Reply | undefined;
  try {
    for (const attempt of attempts) {
      call.mode = attempt.mode;
      reply = await sendChat(env, { ...attempt.body, model: call.model }, timeoutMs);
      if (reply.ok || !reply.rejected) break;
    }
  } catch (e) {
    return fail(isTimeout(e) ? "timeout" : "network", errorMessage(e));
  }
  if (!reply?.ok) return fail("http_error", (reply?.error ?? "No attempt was made").slice(0, 300));

  const body = reply.body;
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
type ChatBody = { model?: string; choices?: { message?: { content?: unknown } }[]; usage?: Usage } | null;
// "rejected" means the provider refused this request's shape (for example response_format), so the next,
// plainer attempt is worth making; any other failure ends the call
export type Reply = { ok: true; body: ChatBody } | { ok: false; rejected: boolean; error: string };

// One chat-completions request to whichever provider serves the model. Throws only on a timeout or a
// network failure; Phase 0's model check uses it too, so the check exercises the same path as the products.
export function sendChat(env: Env, body: Record<string, unknown> & { model: string }, timeoutMs: number): Promise<Reply> {
  if (isWorkersAiModel(body.model)) return sendWorkersAi(env, body, timeoutMs);
  return sendOpenCode(env, readSecret(env, "OPENCODE_API_KEY") ?? "", body, timeoutMs);
}

async function sendOpenCode(env: Env, apiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
  const res = await fetchWithRetry(
    chatUrl(env),
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { timeoutMs, retries: 1 },
  );
  if (!res.ok) return { ok: false, rejected: res.status === 400, error: `HTTP ${res.status}: ${await res.text().catch(() => "")}` };
  return { ok: true, body: (await res.json().catch(() => null)) as ChatBody };
}

// Models on the chat-completions schema (GLM-5.3-Flash among them) answer in the OpenAI shape, so the
// parsing below is shared. The binding has no timeout of its own and reports bad input by throwing.
type WorkersAiRunner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

// Per-model extras. GLM-5.3-Flash reasons at "max" by default, which took over 120 s on a 31-creator
// shortlist; scoring and drafting don't need it, and reasoning can't be switched off, only lowered.
const WORKERS_AI_OPTIONS: Record<string, Record<string, unknown>> = {
  "@cf/zai-org/glm-5.3-flash": { reasoning_effort: "low" },
};

async function sendWorkersAi(env: Env, body: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
  const { model, ...rest } = body;
  const input = { ...rest, ...WORKERS_AI_OPTIONS[String(model)] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Workers AI didn't answer within ${timeoutMs} ms`), { name: "TimeoutError" })), timeoutMs);
  });
  try {
    const out = await Promise.race([(env.AI as unknown as WorkersAiRunner).run(String(model), input), timeout]);
    return { ok: true, body: out as ChatBody };
  } catch (e) {
    if (isTimeout(e)) throw e;
    // An error that names the input or schema means this request's shape was refused, so a plainer one may work
    return { ok: false, rejected: "response_format" in input && /input|schema|response_format/i.test(errorMessage(e)), error: `Workers AI: ${errorMessage(e)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
