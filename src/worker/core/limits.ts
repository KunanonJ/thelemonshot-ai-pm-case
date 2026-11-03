import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./auth";
import { weeklyCost } from "./cost";
import { errorMessage } from "./env";

// Sign-up is open, so anyone can start work that costs money: model calls, Apify actor runs and image
// generations. On the routes that start it, a non-admin gets a daily allowance and is stopped once the
// week's external cost passes the Operator's threshold (System page). Admins are never limited, and work
// already running or scheduled is never cut off.
export const DAILY_PAID_ACTIONS = 20;
const DAY_MS = 86_400_000;

export type LimitError = "weekly_budget_reached" | "daily_limit_reached";

// One counter per user per UTC day; it expires on its own the day after
export function paidActionKey(userId: string, now = Date.now()): string {
  return `paid:${userId}:${new Date(now).toISOString().slice(0, 10)}`;
}

export const paidAction = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("role") === "admin") return next();

  // A cost lookup that fails lets the action through: D1 being down fails the action anyway, more clearly
  const over = await weeklyCost(c.env).then(
    (w) => w.over,
    (e) => (console.error("weekly cost check failed", errorMessage(e)), false),
  );
  if (over) return c.json({ error: "weekly_budget_reached" satisfies LimitError }, 429);

  const key = paidActionKey(c.get("userId"));
  const used = Number(await c.env.CONFIG.get(key).catch(() => null)) || 0;
  if (used >= DAILY_PAID_ACTIONS) return c.json({ error: "daily_limit_reached" satisfies LimitError, limit: DAILY_PAID_ACTIONS }, 429);

  await next();
  // Only an action that went through uses up the allowance
  if (c.res.status < 400) {
    await c.env.CONFIG.put(key, String(used + 1), { expirationTtl: (2 * DAY_MS) / 1000 }).catch((e) =>
      console.error("paid action count not written", errorMessage(e)),
    );
  }
});
