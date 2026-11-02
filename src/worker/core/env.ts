// Secrets are set with `wrangler secret put` (or .dev.vars locally) and may be missing during setup,
// so they're read through this helper instead of being declared on the generated Env type
export type SecretName =
  | "CLERK_SECRET_KEY"
  | "CLERK_PUBLISHABLE_KEY"
  | "APIFY_TOKEN"
  | "OPENCODE_API_KEY"
  | "YOUTUBE_API_KEY"
  | "FAL_API_KEY";

export function readSecret(env: Env, name: SecretName): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Local end-to-end tests only: LLM_CHAT_URL, APIFY_API_URL and YOUTUBE_API_URL in .dev.vars point an
// external API at a mock on localhost. Any other value is ignored, so production always uses the real host.
export type LocalOverride = "LLM_CHAT_URL" | "APIFY_API_URL" | "YOUTUBE_API_URL";

export function localOverride(env: Env, name: LocalOverride, fallback: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(value) ? value.replace(/\/$/, "") : fallback;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
