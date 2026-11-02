import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Button, Card, StatCard, StatusPill, Td, Th } from "../components/ui";
import { useApi, useResource } from "../lib/api";
import { fmtAgo } from "../lib/format";
import type { Role } from "../types";

type Overview = {
  freshness: { source: string; last: number }[];
  staleness: { never: number | null; under_24h: number | null; one_to_three_days: number | null; over_72h: number | null } | null;
  failedJobs: { platform: string; error: string | null; updated_at: number; display_name: string }[];
  failedApifyRuns: { actor: string; purpose: string; status: string; error: string | null; started_at: number }[];
  llm: { product: string; calls: number; failed: number; cost_usd: number }[];
  apify: { purpose: string; runs: number; items: number }[];
  runs: { product: string; status: string; runs: number }[];
  openDeadLetters: number;
};

type Phase0Row = { check_id: string; status: string; detail: Record<string, unknown>; attempts: number; updated_at: string };

const PHASE0 = [
  { id: "clerk-session", label: "Your Clerk session verifies in the Worker", auto: false },
  { id: "clerk-key", label: "Clerk secret key works", auto: true },
  { id: "bindings", label: "D1, KV, R2 and Queue round-trip", auto: true },
  { id: "pptx", label: "pptxgenjs builds a deck in the Worker", auto: true },
  { id: "opencode", label: "OpenCode returns strict JSON", auto: true },
  { id: "apify-instagram", label: "Apify Instagram profile run", auto: true },
  { id: "apify-tiktok", label: "Apify TikTok profile run", auto: true },
];

export function System({ role }: { role: Role }) {
  const api = useApi();
  const overview = useResource<Overview>("/api/admin/overview");
  const flags = useResource<{ llmForceFail: boolean; llmModel: string }>("/api/admin/flags");
  const phase0 = useResource<Phase0Row[]>("/api/admin/phase0/results");
  const [busy, setBusy] = useState<string | null>(null);
  const o = overview.data;

  async function toggleForceFail() {
    await api("/api/admin/flags", { method: "POST", body: { llmForceFail: !flags.data?.llmForceFail } });
    await flags.reload();
  }
  async function runCheck(id: string) {
    setBusy(id);
    try {
      await api(id === "clerk-session" ? "/api/admin/phase0/clerk-session" : `/api/admin/phase0/run/${id}`, { method: "POST" });
    } finally {
      setBusy(null);
      await phase0.reload();
    }
  }

  const llmCalls = o?.llm.reduce((a, r) => a + r.calls, 0) ?? 0;
  const llmCost = o?.llm.reduce((a, r) => a + r.cost_usd, 0) ?? 0;
  const results = new Map((phase0.data ?? []).map((r) => [r.check_id, r]));

  return (
    <Shell role={role} title={<Crumbs items={[{ label: "System" }]} />} actions={<Button onClick={() => void overview.reload()}>Refresh</Button>}>
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Apify data" value={fmtAgo(o?.freshness.find((f) => f.source === "apify")?.last)} hint="Last successful snapshot" />
          <StatCard label="YouTube data" value={fmtAgo(o?.freshness.find((f) => f.source === "youtube_api")?.last)} hint="Last successful snapshot" />
          <StatCard label="LLM calls, 7 days" value={llmCalls} hint={`$${llmCost.toFixed(2)} at OpenCode prices`} />
          <StatCard label="Open dead letters" value={o?.openDeadLetters ?? 0} hint="Listed on the Creators page" />
        </div>

        {o?.staleness && (
          <Card className="p-4 text-[13px]">
            <div className="mb-2 font-semibold">Snapshot age, active creators</div>
            <div className="flex gap-6 tabular-nums">
              <span>Under 24 h: {o.staleness.under_24h ?? 0}</span>
              <span>1 to 3 days: {o.staleness.one_to_three_days ?? 0}</span>
              <span className="text-amber-700">Over 72 h: {o.staleness.over_72h ?? 0}</span>
              <span className="text-neutral-500">Never: {o.staleness.never ?? 0}</span>
            </div>
          </Card>
        )}

        {(o?.failedJobs.length ?? 0) > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold">Failed enrichment, last 7 days</h2>
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <table className="w-full">
                <thead className="border-b border-neutral-200 bg-neutral-50/60">
                  <tr>
                    <Th>Creator</Th>
                    <Th>Platform</Th>
                    <Th>Error</Th>
                    <Th className="text-right">When</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {o!.failedJobs.map((j, i) => (
                    <tr key={i}>
                      <Td>{j.display_name}</Td>
                      <Td>{j.platform}</Td>
                      <Td className="text-neutral-600">{j.error}</Td>
                      <Td className="text-right text-neutral-500">{fmtAgo(j.updated_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <Card className="flex items-center justify-between p-4 text-[13px]">
          <div>
            <div className="font-semibold">Force LLM failure</div>
            <div className="text-neutral-500">
              Test switch for AC-MX-3: every model call fails as if OpenCode were down, and runs fall back to data scores. Model: {flags.data?.llmModel ?? "…"}
            </div>
          </div>
          <Button variant={flags.data?.llmForceFail ? "danger" : "secondary"} onClick={() => void toggleForceFail()}>
            {flags.data?.llmForceFail ? "On, turn off" : "Off, turn on"}
          </Button>
        </Card>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Phase 0 checks</h2>
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-neutral-50/60">
                <tr>
                  <Th>Check</Th>
                  <Th>Status</Th>
                  <Th>Detail</Th>
                  <Th className="text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {PHASE0.map((c) => {
                  const r = results.get(c.id);
                  return (
                    <tr key={c.id}>
                      <Td>
                        <div>{c.label}</div>
                        <div className="text-xs text-neutral-500">{c.auto ? "Runs every 5 minutes until it passes" : "Needs you to press the button"}</div>
                      </Td>
                      <Td>{r ? <StatusPill status={r.status} /> : <span className="text-xs text-neutral-400">not run</span>}</Td>
                      <Td>
                        <code className="block max-w-md truncate text-xs text-neutral-600">{r ? JSON.stringify(r.detail) : ""}</code>
                      </Td>
                      <Td className="text-right">
                        <Button size="sm" disabled={busy !== null} onClick={() => void runCheck(c.id)}>
                          {busy === c.id ? "Running" : c.auto ? "Run now" : "Verify my session"}
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  );
}
