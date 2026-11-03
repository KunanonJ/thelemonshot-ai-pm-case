import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthBridge } from "./auth";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: unknown,
  ) {
    super(code);
  }
}

export type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export function useApi(): Api {
  const { getToken } = useAuthBridge();
  return useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const token = await getToken();
      const res = await fetch(path, {
        method: init.method ?? "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(res.status, body.error ?? `http_${res.status}`, body);
      }
      return (res.headers.get("content-type")?.includes("application/json") ? await res.json() : await res.text()) as T;
    },
    [getToken],
  );
}

// Loads a resource and keeps it fresh; `poll` returns a delay in ms while the data is still changing
export function useResource<T>(path: string | null, poll?: (data: T) => number | null) {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(poll);
  pollRef.current = poll;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const next = await api<T>(path);
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, path]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!data || !pollRef.current) return;
    const delay = pollRef.current(data);
    if (delay === null) return;
    const t = setTimeout(() => void load(), delay);
    return () => clearTimeout(t);
  }, [data, load]);

  return { data, error, loading, reload: load };
}

// Binary-safe variant for exports such as PPTX
export function useDownload() {
  const { getToken } = useAuthBridge();
  return useCallback(
    async (path: string, filename: string): Promise<void> => {
      const token = await getToken();
      const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(res.status, body.error ?? `http_${res.status}`, body);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [getToken],
  );
}

// Downloads need the auth header, so they go through fetch and an object URL
export async function download(api: Api, path: string, filename: string): Promise<void> {
  const text = await api<string>(path);
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
