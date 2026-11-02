import { errorMessage, localOverride, readSecret } from "../../core/env";
import { fetchWithRetry } from "../../core/http";
import { sniffAsset, type AssetType } from "./assets";

// fal queue REST, per fal's queue docs (2 Nov 2026): POST queue.fal.run/<model>, then poll the status_url the
// submit response returned and fetch the response_url once COMPLETED. Auth is "Authorization: Key <FAL_KEY>".
export const FAL_QUEUE_URL = "https://queue.fal.run";
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export type FalFailure = "not_configured" | "submit_failed" | "status_failed" | "result_failed" | "untrusted_url" | "download_failed" | "not_an_image";

export class FalError extends Error {
  constructor(
    readonly reason: FalFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export const falBase = (env: Env) => localOverride(env, "FAL_API_URL", FAL_QUEUE_URL);

function authHeaders(env: Env): Record<string, string> {
  const key = readSecret(env, "FAL_API_KEY");
  if (!key) throw new FalError("not_configured");
  return { Authorization: `Key ${key}` };
}

// The key only ever travels to the queue host, so a status or result URL the response named must share its origin
export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// Inputs and outputs may be plain HTTPS links. Plain HTTP is accepted only for localhost, as localOverride does.
export function isFetchableFalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export async function submitToFal(env: Env, modelId: string, input: Record<string, unknown>): Promise<{ requestId: string; statusUrl: string; responseUrl: string }> {
  const headers = authHeaders(env);
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${falBase(env)}/${modelId}`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input) },
      { timeoutMs: 15_000 },
    );
  } catch (e) {
    throw new FalError("submit_failed", errorMessage(e));
  }
  if (!res.ok) throw new FalError("submit_failed", `HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { request_id?: unknown; status_url?: unknown; response_url?: unknown };
  if (typeof body.request_id !== "string" || typeof body.status_url !== "string" || typeof body.response_url !== "string") {
    throw new FalError("submit_failed", "no request id in the answer");
  }
  const base = falBase(env);
  if (!isSameOrigin(base, body.status_url) || !isSameOrigin(base, body.response_url)) throw new FalError("untrusted_url");
  return { requestId: body.request_id, statusUrl: body.status_url, responseUrl: body.response_url };
}

export async function readFalStatus(env: Env, statusUrl: string): Promise<{ status: string; error: string | null; errorType: string | null }> {
  if (!isSameOrigin(falBase(env), statusUrl)) throw new FalError("untrusted_url");
  let res: Response;
  try {
    res = await fetchWithRetry(statusUrl, { headers: authHeaders(env) }, { timeoutMs: 10_000, retries: 1 });
  } catch (e) {
    throw new FalError("status_failed", errorMessage(e));
  }
  if (!res.ok) throw new FalError("status_failed", `HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { status?: unknown; error?: unknown; error_type?: unknown };
  return {
    status: typeof body.status === "string" ? body.status : "",
    error: typeof body.error === "string" && body.error.length > 0 ? body.error : null,
    errorType: typeof body.error_type === "string" ? body.error_type : null,
  };
}

export async function readFalResult(env: Env, responseUrl: string): Promise<unknown> {
  if (!isSameOrigin(falBase(env), responseUrl)) throw new FalError("untrusted_url");
  let res: Response;
  try {
    res = await fetchWithRetry(responseUrl, { headers: authHeaders(env) }, { timeoutMs: 15_000, retries: 1 });
  } catch (e) {
    throw new FalError("result_failed", errorMessage(e));
  }
  if (!res.ok) throw new FalError("result_failed", `HTTP ${res.status}`);
  return res.json();
}

// The generated file is checked by its own signature, so a non-image answer is never stored
export async function downloadFalImage(url: string): Promise<{ bytes: Uint8Array; type: AssetType }> {
  if (!isFetchableFalUrl(url)) throw new FalError("untrusted_url");
  let res: Response;
  try {
    res = await fetchWithRetry(url, {}, { timeoutMs: 30_000, retries: 1 });
  } catch (e) {
    throw new FalError("download_failed", errorMessage(e));
  }
  if (!res.ok) throw new FalError("download_failed", `HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? "0") > MAX_OUTPUT_BYTES) throw new FalError("download_failed", "too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new FalError("download_failed", "too large");
  const type = sniffAsset(bytes);
  if (!type) throw new FalError("not_an_image");
  return { bytes, type };
}
