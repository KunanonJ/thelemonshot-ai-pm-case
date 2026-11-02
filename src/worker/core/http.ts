import { sleep } from "./util";

// FR-CORE-13: every external call retries with a 2s, 5s, 10s backoff and a 15s per-call timeout.
// Only network errors, timeouts, 429 and 5xx are retried; a 4xx answer is final.
const BACKOFF_MS = [2_000, 5_000, 10_000];

export type RetryOptions = { timeoutMs?: number; retries?: number };

export async function fetchWithRetry(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = Math.min(opts.retries ?? BACKOFF_MS.length, BACKOFF_MS.length);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt === retries) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt === retries) throw e;
    }
    await sleep(BACKOFF_MS[attempt]!);
  }
  throw lastError;
}

export function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}
