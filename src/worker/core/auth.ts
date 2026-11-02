import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { readSecret } from "./env";

export type Role = "admin" | "member" | "viewer";
export type AuthVars = { userId: string; role: Role };
export type AppEnv = { Bindings: Env; Variables: AuthVars };

const ROLES: readonly string[] = ["admin", "member", "viewer"];
const ROLE_CACHE_SECONDS = 60; // KV's minimum TTL, so a role change in Clerk shows up within a minute

// Local end-to-end tests only: needs DEV_AUTH_BYPASS=1 in .dev.vars and a localhost request, so it can't apply in production
export function devAuthBypass(env: Env, url: string): boolean {
  const host = new URL(url).hostname;
  return (env as unknown as Record<string, unknown>).DEV_AUTH_BYPASS === "1" && (host === "localhost" || host === "127.0.0.1");
}

// FR-CORE-1: every /api route needs a Clerk session verified here; FR-CORE-2: the role is resolved server-side
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (devAuthBypass(c.env, c.req.url)) {
    c.set("userId", "local-dev");
    c.set("role", "admin");
    return next();
  }

  const secretKey = readSecret(c.env, "CLERK_SECRET_KEY");
  const publishableKey = readSecret(c.env, "CLERK_PUBLISHABLE_KEY");
  if (!secretKey || !publishableKey) return c.json({ error: "auth_not_configured" }, 503);

  const clerk = createClerkClient({ secretKey, publishableKey });
  const state = await clerk.authenticateRequest(c.req.raw, {
    acceptsToken: "session_token",
    authorizedParties: [new URL(c.req.url).origin],
  });
  if (!state.isAuthenticated) return c.json({ error: "unauthenticated" }, 401);

  const { userId } = state.toAuth();
  c.set("userId", userId);
  c.set("role", await resolveRole(c.env, clerk, userId));
  await next();
});

export const requireRole = (...allowed: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!allowed.includes(c.get("role"))) return c.json({ error: "forbidden" }, 403);
    await next();
  });

// The role lives in the Clerk user's public metadata ({"role": "admin"}); a user without one is a viewer
async function resolveRole(env: Env, clerk: ClerkClient, userId: string): Promise<Role> {
  const cacheKey = `role:${userId}`;
  const cached = await env.CONFIG.get(cacheKey);
  if (cached && ROLES.includes(cached)) return cached as Role;

  const user = await clerk.users.getUser(userId);
  const raw = user.publicMetadata?.role;
  const role: Role = typeof raw === "string" && ROLES.includes(raw) ? (raw as Role) : "viewer";
  await env.CONFIG.put(cacheKey, role, { expirationTtl: ROLE_CACHE_SECONDS });
  return role;
}
