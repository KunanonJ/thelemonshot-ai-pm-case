import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { errorMessage, readSecret } from "./env";

export type Role = "admin" | "member" | "viewer";
export type AuthVars = { userId: string; role: Role };
export type AppEnv = { Bindings: Env; Variables: AuthVars };

const ROLES: readonly string[] = ["admin", "member", "viewer"];
// A role change in Clerk shows up within a minute. The cached copy is kept much longer, so a Clerk outage falls
// back to the last known role instead of turning every request into an error (finding 24).
const ROLE_FRESH_MS = 60_000;
const ROLE_KEEP_SECONDS = 7 * 86_400;

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
  let state;
  try {
    state = await clerk.authenticateRequest(c.req.raw, {
      acceptsToken: "session_token",
      authorizedParties: [new URL(c.req.url).origin],
    });
  } catch (e) {
    console.error("clerk session check failed", errorMessage(e));
    return c.json({ error: "auth_unavailable" }, 503);
  }
  if (!state.isAuthenticated) return c.json({ error: "unauthenticated" }, 401);

  const { userId } = state.toAuth();
  const role = await resolveRole(c.env, clerk, userId);
  if (!role) return c.json({ error: "auth_unavailable" }, 503);
  c.set("userId", userId);
  c.set("role", role);
  await next();
});

export const requireRole = (...allowed: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!allowed.includes(c.get("role"))) return c.json({ error: "forbidden" }, 403);
    await next();
  });

export type CachedRole = { role: Role; at: number };

// Entries written before the freshness timestamp existed are a bare role: usable as a fallback, never fresh
export function parseCachedRole(raw: string | null): CachedRole | null {
  if (!raw) return null;
  if (ROLES.includes(raw)) return { role: raw as Role, at: 0 };
  try {
    const v = JSON.parse(raw) as Partial<CachedRole>;
    return typeof v.role === "string" && ROLES.includes(v.role) && typeof v.at === "number" ? { role: v.role, at: v.at } : null;
  } catch {
    return null;
  }
}

// Sign-up is open, so anyone who signs in can try every product: a user with no role set is a member.
// {"role": "viewer"} in public metadata still makes someone read-only; {"role": "admin"} adds System and the roster.
// Members' paid runs are capped in core/limits.ts.
export const DEFAULT_ROLE: Role = "member";

export function roleFromMetadata(raw: unknown): Role {
  return typeof raw === "string" && ROLES.includes(raw) ? (raw as Role) : DEFAULT_ROLE;
}

// The role lives in the Clerk user's public metadata ({"role": "admin"}).
// Null means Clerk can't be asked and no earlier answer is cached, so the request can't be authorised.
async function resolveRole(env: Env, clerk: ClerkClient, userId: string): Promise<Role | null> {
  const cacheKey = `role:${userId}`;
  const cached = parseCachedRole(await env.CONFIG.get(cacheKey).catch(() => null));
  if (cached && Date.now() - cached.at < ROLE_FRESH_MS) return cached.role;
  let role: Role;
  try {
    const user = await clerk.users.getUser(userId);
    role = roleFromMetadata(user.publicMetadata?.role);
  } catch (e) {
    console.error("clerk role lookup failed", { userId, cached: cached?.role ?? null, error: errorMessage(e) });
    return cached?.role ?? null;
  }
  await env.CONFIG.put(cacheKey, JSON.stringify({ role, at: Date.now() } satisfies CachedRole), { expirationTtl: ROLE_KEEP_SECONDS }).catch((e) =>
    console.error("role cache not written", { userId, error: errorMessage(e) }),
  );
  return role;
}
