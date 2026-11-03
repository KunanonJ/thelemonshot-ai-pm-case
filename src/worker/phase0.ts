import { Hono } from "hono";
import pptxgen from "pptxgenjs";
import { createClerkClient } from "@clerk/backend";
import { z } from "zod";
import { requireRole, type AppEnv } from "./core/auth";
import { errorMessage, readSecret, type SecretName } from "./core/env";
import { activeModel, isWorkersAiModel, modelConfigured, sendChat } from "./core/llm";

// Phase 0 diagnostics from the build brief. Every check stores pass/fail with non-secret detail only.
// The cron runs each check as soon as its secrets exist, so Phase 0 completes without anyone at a desk;
// only the session half of the Clerk check needs a person to sign in.

type Status = "pass" | "fail" | "running" | "waiting";
type CheckResult = { check: string; status: Status; detail: Record<string, unknown>; ms: number };
type ApifyPlatform = "instagram" | "tiktok";

export type Phase0Message =
  | { kind: "phase0-echo"; probe: string }
  | { kind: "phase0-apify-poll"; platform: ApifyPlatform; runId: string; startedAt: number };

const APIFY_API = "https://api.apify.com/v2";
// Maintained, high-success profile actors (Apify Store, 2 Nov 2026), probed with the platforms' own public accounts
const APIFY_ACTORS: Record<ApifyPlatform, { actor: string; input: Record<string, unknown> }> = {
  instagram: { actor: "apify~instagram-profile-scraper", input: { usernames: ["instagram"] } },
  tiktok: { actor: "clockworks~tiktok-profile-scraper", input: { profiles: ["tiktok"], resultsPerPage: 3 } },
};

const API_TIMEOUT_MS = 15_000; // FR-CORE-13
const LLM_TIMEOUT_MS = 30_000;
const APIFY_POLL_LIMIT_MS = 5 * 60_000; // FR-CORE-13: Apify polling window
const QUEUE_ECHO_WAIT_MS = 20_000;
const AUTO_RETRY_AFTER_MS = 15 * 60_000;
const AUTO_MAX_ATTEMPTS = 4;
const STALE_RUNNING_MS = 10 * 60_000;

// ---------- checks ----------

async function checkBindings(env: Env): Promise<CheckResult> {
  const started = Date.now();
  const probe = `phase0-${crypto.randomUUID()}`;
  const detail: Record<string, unknown> = {};
  try {
    detail.d1 = (await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>())?.ok === 1;

    await env.CONFIG.put(probe, "ok", { expirationTtl: 60 });
    detail.kv = (await env.CONFIG.get(probe)) === "ok";

    await env.FILES.put(`phase0/${probe}.txt`, "ok");
    detail.r2 = (await (await env.FILES.get(`phase0/${probe}.txt`))?.text()) === "ok";
    await env.FILES.delete(`phase0/${probe}.txt`);

    // The consumer records the probe in D1 (strongly consistent), so polling for it proves delivery
    await env.ENRICH_QUEUE.send({ kind: "phase0-echo", probe } satisfies Phase0Message);
    detail.queue = await waitFor(async () => {
      const row = await env.DB.prepare("SELECT probe FROM phase0_echo WHERE probe = ?").bind(probe).first();
      return row !== null;
    }, QUEUE_ECHO_WAIT_MS);
  } catch (e) {
    detail.error = errorMessage(e);
  }
  const pass = ["d1", "kv", "r2", "queue"].every((k) => detail[k] === true);
  return finished("bindings", pass, detail, started);
}

async function checkPptx(env: Env): Promise<CheckResult> {
  const started = Date.now();
  try {
    const pres = new pptxgen();
    pres.addSlide().addText("Lemon Shot AI Suite: pptxgenjs smoke test", { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 24 });
    const data = (await pres.write({ outputType: "uint8array" })) as Uint8Array;
    const key = "phase0/pptx-smoke.pptx";
    await env.FILES.put(key, data, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    });
    return finished("pptx", data.byteLength > 0, { bytes: data.byteLength, r2Key: key }, started);
  } catch (e) {
    return finished("pptx", false, { error: errorMessage(e) }, started);
  }
}

// Proves the secret key works and Clerk is reachable; the session half runs from /clerk-session
async function checkClerkKey(env: Env): Promise<CheckResult> {
  const secretKey = readSecret(env, "CLERK_SECRET_KEY");
  if (!secretKey) return waiting("clerk-key", ["CLERK_SECRET_KEY"]);
  const started = Date.now();
  try {
    const users = await createClerkClient({ secretKey }).users.getCount();
    const publishableKeySet = Boolean(readSecret(env, "CLERK_PUBLISHABLE_KEY"));
    return finished("clerk-key", publishableKeySet, { reachable: true, users, publishableKeySet }, started);
  } catch (e) {
    return finished("clerk-key", false, { error: errorMessage(e) }, started);
  }
}

const ModelAnswer = z.object({ ok: z.literal(true), sum: z.number() });

// The model the products use (Workers AI by default, or the admin's llm:model), through the same sendChat
async function checkModel(env: Env): Promise<CheckResult> {
  const model = await activeModel(env);
  if (!modelConfigured(env, model)) return isWorkersAiModel(model) ? finished("llm", false, { model, error: "The AI binding is missing" }, Date.now()) : waiting("llm", ["OPENCODE_API_KEY"]);
  const started = Date.now();
  const messages = [
    { role: "system", content: "Reply with one JSON object only: no prose, no code fences." },
    { role: "user", content: 'Return {"ok": true, "sum": <the sum of 2 and 3>}.' },
  ];
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "phase0_answer",
      strict: true,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, sum: { type: "number" } },
        required: ["ok", "sum"],
        additionalProperties: false,
      },
    },
  };
  try {
    // Prefer schema-enforced output; if the provider rejects response_format, fall back to prompt-only JSON
    let mode = "json_schema";
    let reply = await sendChat(env, { model, messages, max_tokens: 1_000, response_format: responseFormat }, LLM_TIMEOUT_MS);
    if (!reply.ok && reply.rejected) {
      mode = "prompt_only";
      reply = await sendChat(env, { model, messages, max_tokens: 1_000 }, LLM_TIMEOUT_MS);
    }
    if (!reply.ok) return finished("llm", false, { model, mode, error: reply.error.slice(0, 500) }, started);
    const content = reply.body?.choices?.[0]?.message?.content;
    const parsed = ModelAnswer.safeParse(parseJsonObject(typeof content === "string" ? content : ""));
    const pass = parsed.success && parsed.data.sum === 5;
    return finished("llm", pass, { model, mode, schemaValid: parsed.success, usage: reply.body?.usage }, started);
  } catch (e) {
    return finished("llm", false, { model, error: errorMessage(e) }, started);
  }
}

// Apify runs take minutes, so the start returns "running" and the queue consumer polls (start, poll, fetch)
async function startApifyRun(env: Env, platform: ApifyPlatform): Promise<CheckResult> {
  const check = `apify-${platform}`;
  const token = readSecret(env, "APIFY_TOKEN");
  if (!token) return waiting(check, ["APIFY_TOKEN"]);
  const started = Date.now();
  const { actor, input } = APIFY_ACTORS[platform];
  try {
    const res = await fetch(`${APIFY_API}/actors/${actor}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return finished(check, false, { actor, httpStatus: res.status, error: await errorText(res) }, started);
    const run = ((await res.json()) as { data: { id: string; status: string } }).data;
    await env.ENRICH_QUEUE.send(
      { kind: "phase0-apify-poll", platform, runId: run.id, startedAt: started } satisfies Phase0Message,
      { delaySeconds: 20 },
    );
    return { check, status: "running", detail: { actor, runId: run.id, runStatus: run.status }, ms: Date.now() - started };
  } catch (e) {
    return finished(check, false, { actor, error: errorMessage(e) }, started);
  }
}

export async function pollApifyRun(env: Env, msg: Extract<Phase0Message, { kind: "phase0-apify-poll" }>): Promise<void> {
  const check = `apify-${msg.platform}`;
  const { actor } = APIFY_ACTORS[msg.platform];
  const token = readSecret(env, "APIFY_TOKEN");
  if (!token) return saveResult(env, waiting(check, ["APIFY_TOKEN"]));
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const res = await fetch(`${APIFY_API}/actor-runs/${msg.runId}?waitForFinish=50`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return saveResult(env, finished(check, false, { actor, runId: msg.runId, httpStatus: res.status }, msg.startedAt));
    const run = ((await res.json()) as { data: { status: string; defaultDatasetId: string } }).data;

    if (run.status === "SUCCEEDED") {
      const itemsRes = await fetch(`${APIFY_API}/datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=5`, {
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const items = itemsRes.ok ? ((await itemsRes.json()) as Record<string, unknown>[]) : [];
      // Keep a sample of the dataset shape in R2: the Phase 1 normalisers are written against it
      const sampleKey = `phase0/apify-${msg.platform}-sample.json`;
      await env.FILES.put(sampleKey, JSON.stringify(items.slice(0, 2), null, 2), { httpMetadata: { contentType: "application/json" } });
      const fields = Object.keys(items[0] ?? {}).sort();
      return saveResult(env, finished(check, items.length > 0, { actor, runId: msg.runId, items: items.length, fields, sampleKey }, msg.startedAt));
    }
    if ((run.status === "READY" || run.status === "RUNNING") && Date.now() - msg.startedAt < APIFY_POLL_LIMIT_MS) {
      await env.ENRICH_QUEUE.send(msg, { delaySeconds: 15 });
      return;
    }
    return saveResult(env, finished(check, false, { actor, runId: msg.runId, runStatus: run.status }, msg.startedAt));
  } catch (e) {
    return saveResult(env, finished(check, false, { actor, runId: msg.runId, error: errorMessage(e) }, msg.startedAt));
  }
}

export async function recordEcho(env: Env, probe: string): Promise<void> {
  await ensureTables(env);
  await env.DB.prepare("INSERT OR REPLACE INTO phase0_echo (probe, received_at) VALUES (?, ?)").bind(probe, Date.now()).run();
}

// ---------- automatic runner (cron) ----------

const AUTO_CHECKS: { id: string; run: (env: Env) => Promise<CheckResult> }[] = [
  { id: "bindings", run: checkBindings },
  { id: "pptx", run: checkPptx },
  { id: "clerk-key", run: checkClerkKey },
  { id: "llm", run: checkModel },
  { id: "apify-instagram", run: (env) => startApifyRun(env, "instagram") },
  { id: "apify-tiktok", run: (env) => startApifyRun(env, "tiktok") },
];

export async function runPhase0Auto(env: Env): Promise<void> {
  await ensureTables(env);
  const { results } = await env.DB.prepare("SELECT check_id, status, attempts, updated_at FROM phase0_results").all<StoredRow>();
  const previous = new Map(results.map((r) => [r.check_id, r]));

  for (const { id, run } of AUTO_CHECKS) {
    const prev = previous.get(id);
    const age = prev ? Date.now() - Date.parse(prev.updated_at) : Infinity;
    if (prev?.status === "pass") continue;
    // A check stuck "running" restarts after a while, and stops after a few tries, since each Apify one is a paid run
    if (prev?.status === "running" && (age < STALE_RUNNING_MS || prev.attempts >= AUTO_MAX_ATTEMPTS)) continue;
    // Failures retry a few times, spaced out, so a bad token can't keep burning paid actor runs
    if (prev?.status === "fail" && (age < AUTO_RETRY_AFTER_MS || prev.attempts >= AUTO_MAX_ATTEMPTS)) continue;
    await saveResult(env, await run(env));
  }
}

// ---------- storage ----------

type StoredRow = { check_id: string; status: Status; detail: string; ms: number; attempts: number; updated_at: string };

async function ensureTables(env: Env): Promise<void> {
  // Phase 0 only: the product schema arrives with the Drizzle migrations in Phase 1
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS phase0_echo (probe TEXT PRIMARY KEY, received_at INTEGER NOT NULL)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS phase0_results (check_id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT NOT NULL, ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)",
    ),
  ]);
}

async function saveResult(env: Env, r: CheckResult): Promise<void> {
  await ensureTables(env);
  // Waiting for a secret is not an attempt; anything that actually ran is
  const attemptIncrement = r.status === "waiting" ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO phase0_results (check_id, status, detail, ms, attempts, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(check_id) DO UPDATE SET status = ?2, detail = ?3, ms = ?4, attempts = attempts + ?5, updated_at = ?6`,
  )
    .bind(r.check, r.status, JSON.stringify(r.detail), r.ms, attemptIncrement, new Date().toISOString())
    .run();
}

// ---------- HTTP routes (admin only) ----------

export const phase0 = new Hono<AppEnv>();
phase0.use("*", requireRole("admin"));

phase0.get("/results", async (c) => {
  await ensureTables(c.env);
  const { results } = await c.env.DB.prepare("SELECT * FROM phase0_results ORDER BY check_id").all<StoredRow>();
  return c.json(results.map((r) => ({ ...r, detail: JSON.parse(r.detail) as unknown })));
});

// The one check a person has to run: their own Clerk session verified by @clerk/backend in the Worker
phase0.post("/clerk-session", async (c) => {
  const r = finished("clerk-session", true, { userId: c.get("userId"), role: c.get("role") }, Date.now());
  await saveResult(c.env, r);
  return c.json(r);
});

phase0.post("/run/:check", async (c) => {
  const entry = AUTO_CHECKS.find((x) => x.id === c.req.param("check"));
  if (!entry) return c.json({ error: "unknown_check" }, 404);
  await ensureTables(c.env);
  const r = await entry.run(c.env);
  await saveResult(c.env, r);
  return c.json(r);
});

// ---------- helpers ----------


function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function errorText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function finished(check: string, pass: boolean, detail: Record<string, unknown>, started: number): CheckResult {
  return { check, status: pass ? "pass" : "fail", detail, ms: Date.now() - started };
}

function waiting(check: string, secrets: SecretName[]): CheckResult {
  return { check, status: "waiting", detail: { waitingFor: secrets }, ms: 0 };
}
