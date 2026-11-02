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

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
