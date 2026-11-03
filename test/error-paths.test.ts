import { describe, expect, it } from "vitest";
import { parseCachedRole } from "../src/worker/core/auth";
import { isUniqueViolation } from "../src/worker/core/db/client";
import { ApifyNotConfigured } from "../src/worker/core/enrichment/apify";
import { classifySourceFailure, clearDegraded, degradedSources, markDegraded, SOURCE_FAILURE_TEXT } from "../src/worker/core/enrichment/failures";
import { RUN_FAILURE_TEXT } from "../src/worker/products/matrix/pipeline";
import { digestRunId, plainFailures } from "../src/worker/products/optimization/digest";
import { MAX_DELIVERIES, refOf, retryDelaySeconds } from "../src/worker/queue";
import { parseCronStatus } from "../src/worker/sweeper";

// An in-memory stand-in for the KV namespace, with an optional failure switch
function fakeKv(opts: { failReads?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => {
      if (opts.failReads) throw new Error("KV unavailable");
      return store.get(k) ?? null;
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}
const envWith = (kv: ReturnType<typeof fakeKv>) => ({ CONFIG: kv }) as unknown as Env;

describe("queue retries and the last delivery (finding 1)", () => {
  it("spaces retries out instead of running them back to back", () => {
    expect([1, 2, 3].map(retryDelaySeconds)).toEqual([15, 60, 180]);
    expect(retryDelaySeconds(0)).toBe(15);
    expect(retryDelaySeconds(9)).toBe(180);
  });

  it("treats the fourth delivery as the last, matching max_retries 3", () => {
    expect(MAX_DELIVERIES).toBe(4);
  });

  it("logs ids only, with long creator lists summarised", () => {
    expect(refOf({ kind: "matrix-run", runId: "r1" })).toEqual({ runId: "r1" });
    expect(refOf({ kind: "enrich", creatorIds: ["a", "b", "c"], reason: "sweep", requestedBy: "system:cron" })).toEqual({ creatorIds: "3 ids" });
    expect(refOf({ kind: "dco-visual", runId: "r", planKey: "p", origin: "https://x", requestedBy: "u" })).toEqual({ runId: "r", planKey: "p" });
  });
});

describe("source failures in plain words (findings 9, 18, 22)", () => {
  it("maps upstream errors to a fixed code", () => {
    expect(classifySourceFailure(new ApifyNotConfigured())).toBe("not_configured");
    expect(classifySourceFailure(new Error("YOUTUBE_API_KEY is not set"))).toBe("not_configured");
    expect(classifySourceFailure(new Error("videos.list returned HTTP 403"))).toBe("refused");
    expect(classifySourceFailure(new Error("Apify start failed: HTTP 402 {\"error\":{\"type\":\"not-enough-usage\"}}"))).toBe("limited");
    expect(classifySourceFailure(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifySourceFailure(new Error("Apify run lookup failed: HTTP 502"))).toBe("unavailable");
    expect(classifySourceFailure("plain string")).toBe("unavailable");
  });

  it("never passes raw text through, including failures stored before codes existed", () => {
    const out = plainFailures([
      { platform: "youtube", error: "videos.list returned HTTP 403" },
      { platform: "instagram", error: "ignored", code: "timeout" },
      { platform: "tiktok", error: "x", code: "made_up" },
    ]);
    expect(out).toEqual([
      { platform: "youtube", code: "unavailable", error: SOURCE_FAILURE_TEXT.unavailable },
      { platform: "instagram", code: "timeout", error: SOURCE_FAILURE_TEXT.timeout },
      { platform: "tiktok", code: "unavailable", error: SOURCE_FAILURE_TEXT.unavailable },
    ]);
    for (const f of out) expect(f.error).not.toMatch(/HTTP|\{/);
  });

  it("keeps Matrix failure text plain and complete", () => {
    for (const text of Object.values(RUN_FAILURE_TEXT)) {
      expect(text).toMatch(/\.$/);
      expect(text).not.toMatch(/Error|HTTP|SQLITE|D1_/);
    }
  });
});

describe("degraded sources (finding 18)", () => {
  it("records a source outage once, keeps when it started, and clears on success", async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    await markDegraded(env, "apify", "refused");
    const [first] = await degradedSources(env);
    expect(first).toMatchObject({ source: "apify", reason: SOURCE_FAILURE_TEXT.refused });
    await markDegraded(env, "apify", "unavailable");
    const [second] = await degradedSources(env);
    expect(second!.since).toBe(first!.since);
    expect(second!.reason).toBe(SOURCE_FAILURE_TEXT.unavailable);
    await clearDegraded(env, "apify");
    expect(await degradedSources(env)).toEqual([]);
  });

  it("reads a KV failure as nothing degraded rather than an error", async () => {
    expect(await degradedSources(envWith(fakeKv({ failReads: true })))).toEqual([]);
  });

  it("ignores a stored value it can't read", async () => {
    const kv = fakeKv();
    kv.store.set("source:degraded:youtube_api", "not json");
    expect(await degradedSources(envWith(kv))).toEqual([]);
  });
});

describe("cached roles survive a Clerk outage (finding 24)", () => {
  it("reads the current format with its freshness time", () => {
    expect(parseCachedRole(JSON.stringify({ role: "member", at: 123 }))).toEqual({ role: "member", at: 123 });
  });

  it("treats an entry from before the freshness time as usable but never fresh", () => {
    expect(parseCachedRole("admin")).toEqual({ role: "admin", at: 0 });
  });

  it("rejects anything else", () => {
    expect(parseCachedRole(null)).toBeNull();
    expect(parseCachedRole("superuser")).toBeNull();
    expect(parseCachedRole(JSON.stringify({ role: "owner", at: 1 }))).toBeNull();
    expect(parseCachedRole("{broken")).toBeNull();
  });
});

describe("constraint errors, however Drizzle hands them over", () => {
  const d1 = new Error("D1_ERROR: UNIQUE constraint failed: creators.instagram: SQLITE_CONSTRAINT");
  it("reads a batch's raw D1 error", () => {
    expect(isUniqueViolation(d1)).toBe(true);
    expect(isUniqueViolation(d1, /creators\.(instagram|tiktok|youtube)/)).toBe(true);
    expect(isUniqueViolation(d1, /runs\.id/)).toBe(false);
  });
  it("reads a single query's wrapped error through its cause (finding 21)", () => {
    const wrapped = Object.assign(new Error("Failed query: insert into \"creators\" ...\nparams: ..."), { cause: d1 });
    expect(isUniqueViolation(wrapped, /creators\.instagram/)).toBe(true);
  });
  it("doesn't mistake other errors for a duplicate", () => {
    expect(isUniqueViolation(new Error("D1_ERROR: database is locked"))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error("Failed query"), { cause: new Error("network connection lost") }))).toBe(false);
    expect(isUniqueViolation("UNIQUE constraint failed")).toBe(false);
  });
});

describe("digests and the cron record", () => {
  it("derives one digest run id per refresh, so a redelivery can't write a second (finding 12)", () => {
    expect(digestRunId("abc")).toBe("digest-abc");
    expect(digestRunId("abc")).toBe(digestRunId("abc"));
  });

  it("reads the cron status the scheduler writes, and nothing else (finding 19)", () => {
    const status = { at: "2026-11-02T10:00:00.000Z", failed: [{ step: "enrichment-sweep", error: "D1 timeout" }] };
    expect(parseCronStatus(JSON.stringify(status))).toEqual(status);
    expect(parseCronStatus(null)).toBeNull();
    expect(parseCronStatus("{}")).toBeNull();
    expect(parseCronStatus("nope")).toBeNull();
  });
});
