import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE, roleFromMetadata, type AppEnv, type Role } from "../src/worker/core/auth";
import { DAILY_PAID_ACTIONS, paidAction, paidActionKey } from "../src/worker/core/limits";

// In-memory KV plus a D1 stand-in that answers the weekly cost queries with a chosen model spend
function fakeEnv(opts: { llmUsd?: number; failDb?: boolean } = {}) {
  const store = new Map<string, string>();
  const statement = (sql: string) => ({
    bind: () => ({
      all: async () => {
        if (opts.failDb) throw new Error("D1 unavailable");
        return { results: sql.includes("FROM llm_calls") && opts.llmUsd ? [{ product: "matrix", usd: opts.llmUsd }] : [] };
      },
      first: async () => ({ n: 0 }),
    }),
  });
  const env = {
    CONFIG: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) },
    DB: { prepare: statement },
  } as unknown as Env;
  return { env, store };
}

function appFor(role: Role, status = 200) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "user_1");
    c.set("role", role);
    await next();
  });
  app.post("/run", paidAction, (c) => c.json({ ok: status < 400 }, status as 200));
  return app;
}

const post = (app: Hono<AppEnv>, env: Env) => app.request("/run", { method: "POST" }, env);

describe("open sign-up: default role", () => {
  it("makes a user with no role a member, so they can try every product", () => {
    expect(DEFAULT_ROLE).toBe("member");
    expect(roleFromMetadata(undefined)).toBe("member");
    expect(roleFromMetadata("superuser")).toBe("member");
  });

  it("keeps a role set in Clerk metadata", () => {
    expect(roleFromMetadata("viewer")).toBe("viewer");
    expect(roleFromMetadata("admin")).toBe("admin");
  });
});

describe("paid action limits", () => {
  it("counts each action that went through, per user per UTC day", async () => {
    const { env, store } = fakeEnv();
    const app = appFor("member");
    expect((await post(app, env)).status).toBe(200);
    expect((await post(app, env)).status).toBe(200);
    expect(store.get(paidActionKey("user_1"))).toBe("2");
    expect(paidActionKey("user_1", Date.UTC(2026, 10, 3, 23, 59))).toBe("paid:user_1:2026-11-03");
  });

  it("stops a member at the daily allowance", async () => {
    const { env, store } = fakeEnv();
    store.set(paidActionKey("user_1"), String(DAILY_PAID_ACTIONS));
    const res = await post(appFor("member"), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "daily_limit_reached", limit: DAILY_PAID_ACTIONS });
  });

  it("doesn't use up the allowance when the action itself fails", async () => {
    const { env, store } = fakeEnv();
    expect((await post(appFor("member", 400), env)).status).toBe(400);
    expect(store.has(paidActionKey("user_1"))).toBe(false);
  });

  it("pauses members' paid runs once the week's cost passes the threshold", async () => {
    // USD 100 at the default 33 THB/USD is 3,300 THB, over the 1,500 THB default threshold
    const { env } = fakeEnv({ llmUsd: 100 });
    const res = await post(appFor("member"), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "weekly_budget_reached" });
  });

  it("never limits an admin", async () => {
    const { env, store } = fakeEnv({ llmUsd: 100 });
    store.set(paidActionKey("user_1"), String(DAILY_PAID_ACTIONS + 5));
    expect((await post(appFor("admin"), env)).status).toBe(200);
  });

  it("lets the action through when the cost lookup fails", async () => {
    const { env } = fakeEnv({ failDb: true });
    expect((await post(appFor("member"), env)).status).toBe(200);
  });
});
