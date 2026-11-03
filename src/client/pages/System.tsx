import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Input, StatCard, StatusPill, Td, Th } from "../components/ui";
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
  cron: { last: string | null; status: { at: string; failed: { step: string; error: string }[] } | null };
};

// Plain words for the stuck-work sweep's counts
const SWEEP_PARTS: Record<string, string> = {
  matrixRuns: "Matrix runs",
  proposalSections: "proposal sections",
  campaignRefreshes: "campaign refreshes",
  digests: "digests requeued",
  trends: "trend pulls and runs",
  dco: "creative slots",
  enrichmentJobs: "enrichment jobs",
  apifyRuns: "Apify runs stopped",
};

function describeSweep(r: Record<string, unknown>): string {
  const moved = Object.entries(SWEEP_PARTS).flatMap(([k, label]) => (typeof r[k] === "number" && (r[k] as number) > 0 ? [`${r[k]} ${label}`] : []));
  const failed = Array.isArray(r.failedParts) && r.failedParts.length ? ` Some parts couldn't run: ${(r.failedParts as string[]).map((k) => SWEEP_PARTS[k] ?? k).join(", ")}.` : "";
  return `${moved.length ? `Settled ${moved.join(", ")}.` : "Nothing was stuck."}${failed}`;
}

type WeeklyCost = {
  llmUsd: number;
  apifyUsd: number;
  totalUsd: number;
  totalThb: number;
  byProduct: { product: string; usd: number }[];
  apifyRunsWithoutCost: number;
  imageGenerations: number;
  settings: { weeklyThresholdThb: number; usdToThb: number; rateSetByOperator: boolean };
  over: boolean;
};

type Phase0Row = { check_id: string; status: string; detail: Record<string, unknown>; attempts: number; updated_at: string };

const PHASE0 = [
  { id: "clerk-session", label: "Your Clerk session verifies in the Worker", auto: false },
  { id: "clerk-key", label: "Clerk secret key works", auto: true },
  { id: "bindings", label: "D1, KV, R2 and Queue round-trip", auto: true },
  { id: "pptx", label: "pptxgenjs builds a deck in the Worker", auto: true },
  { id: "llm", label: "The AI model returns strict JSON", auto: true },
  { id: "apify-instagram", label: "Apify Instagram profile run", auto: true },
  { id: "apify-tiktok", label: "Apify TikTok profile run", auto: true },
];

export function System({ role }: { role: Role }) {
  const api = useApi();
  const overview = useResource<Overview>("/api/admin/overview");
  const flags = useResource<{ llmForceFail: boolean; llmModel: string }>("/api/admin/flags");
  const phase0 = useResource<Phase0Row[]>("/api/admin/phase0/results");
  const cost = useResource<WeeklyCost>("/api/admin/cost");
  const [busy, setBusy] = useState<string | null>(null);
  const [opsNote, setOpsNote] = useState<string | null>(null);
  const [threshold, setThreshold] = useState("");
  const [rate, setRate] = useState("");
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

  async function operate(id: string, path: string, describe: (r: Record<string, number>) => string) {
    setBusy(id);
    setOpsNote(null);
    try {
      setOpsNote(describe(await api<Record<string, number>>(path, { method: "POST", body: {} })));
    } catch {
      setOpsNote("That didn't go through. Try again.");
    } finally {
      setBusy(null);
      await Promise.all([overview.reload(), cost.reload()]);
    }
  }
  async function saveCost() {
    const body = { weeklyThresholdThb: Number(threshold || cost.data?.settings.weeklyThresholdThb), usdToThb: Number(rate || cost.data?.settings.usdToThb) };
    setBusy("cost");
    try {
      await api("/api/admin/cost/settings", { method: "POST", body });
      setThreshold("");
      setRate("");
    } finally {
      setBusy(null);
      await cost.reload();
    }
  }

  const w = cost.data;
  const llmCalls = o?.llm.reduce((a, r) => a + r.calls, 0) ?? 0;
  const llmCost = o?.llm.reduce((a, r) => a + r.cost_usd, 0) ?? 0;
  const results = new Map((phase0.data ?? []).map((r) => [r.check_id, r]));

  return (
    <Shell role={role} title={<Crumbs items={[{ label: "System" }]} />} actions={<Button onClick={() => void overview.reload()}>Refresh</Button>}>
      <div className="space-y-6">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Apify data" value={fmtAgo(o?.freshness.find((f) => f.source === "apify")?.last)} hint="Last successful snapshot" />
          <StatCard label="YouTube data" value={fmtAgo(o?.freshness.find((f) => f.source === "youtube_api")?.last)} hint="Last successful snapshot" />
          <StatCard label="LLM calls, 7 days" value={llmCalls} hint={`$${llmCost.toFixed(2)} at list prices (Workers AI is free within 10,000 Neurons a day)`} />
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

        {o?.cron && (
          <Card className="p-4 text-[13px]">
            <div className="font-semibold">Scheduled jobs</div>
            <div className="text-neutral-500">Last run finished {o.cron.last ? fmtAgo(Date.parse(o.cron.last)) : "never"}.</div>
            {o.cron.status?.failed.length ? (
              <ul className="mt-2 space-y-1 text-red-700">
                {o.cron.status.failed.map((f) => (
                  <li key={f.step}>
                    {f.step}: {f.error}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-neutral-500">Every step completed in the last run.</div>
            )}
          </Card>
        )}

        {(o?.failedApifyRuns.length ?? 0) > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold">Failed and stuck Apify runs, last 7 days</h2>
            <div className="mb-2 text-xs text-neutral-500">Stuck means still running well after its poll window; the stuck-work sweep stops it so it doesn't keep billing.</div>
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <table className="w-full">
                <thead className="border-b border-neutral-200 bg-neutral-50/60">
                  <tr>
                    <Th>Actor</Th>
                    <Th>Purpose</Th>
                    <Th>Status</Th>
                    <Th>Error</Th>
                    <Th className="text-right">Started</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {o!.failedApifyRuns.map((r, i) => (
                    <tr key={i}>
                      <Td>{r.actor}</Td>
                      <Td>{r.purpose}</Td>
                      <Td className={r.status === "STUCK" ? "font-medium text-amber-700" : undefined}>{r.status}</Td>
                      <Td className="text-neutral-600">{r.error}</Td>
                      <Td className="text-right text-neutral-500">{fmtAgo(r.started_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
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

        {w && (
          <Card className="p-4 text-[13px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold">External cost, last 7 days</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  ฿{w.totalThb.toLocaleString("en")} <span className="text-sm font-normal text-neutral-500">of ฿{w.settings.weeklyThresholdThb.toLocaleString("en")} threshold</span>
                </div>
                <div className="text-xs text-neutral-500">
                  ${w.totalUsd.toFixed(2)} (model ${w.llmUsd.toFixed(2)}, Apify ${w.apifyUsd.toFixed(2)}) at {w.settings.usdToThb} THB per USD
                  {!w.settings.rateSetByOperator && ", a placeholder rate until you set your own"}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <label className="text-xs text-neutral-500">
                  Threshold ฿
                  <Input className="mt-1 w-24" type="number" min={0} value={threshold} placeholder={String(w.settings.weeklyThresholdThb)} onChange={(e) => setThreshold(e.target.value)} />
                </label>
                <label className="text-xs text-neutral-500">
                  THB per USD
                  <Input className="mt-1 w-20" type="number" min={0} step="0.01" value={rate} placeholder={String(w.settings.usdToThb)} onChange={(e) => setRate(e.target.value)} />
                </label>
                <Button size="sm" disabled={busy !== null || (!threshold && !rate)} onClick={() => void saveCost()}>
                  Save
                </Button>
              </div>
            </div>
            {w.over && (
              <div className="mt-3">
                <Banner title="Over the weekly threshold">
                  Members can't start new paid runs until the week's cost drops below the threshold or you raise it; admins aren't limited. Check what ran this week below
                  and on the product pages.
                </Banner>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600 tabular-nums">
              {w.byProduct.map((p) => (
                <span key={p.product}>
                  {p.product}: ${p.usd.toFixed(2)}
                </span>
              ))}
              {w.apifyRunsWithoutCost > 0 && <span className="text-amber-700">{w.apifyRunsWithoutCost} Apify runs reported no cost</span>}
              {w.imageGenerations > 0 && <span>{w.imageGenerations} image generations (fal.ai reports no cost)</span>}
            </div>
          </Card>
        )}

        <Card className="p-4 text-[13px]">
          <div className="font-semibold">Before a demo</div>
          <div className="text-neutral-500">
            Pre-warm refreshes every active creator whose data is over 12 hours old and every active campaign, so no demo step waits on a live pull (NFR-7).
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void operate("prewarm", "/api/admin/prewarm", (r) => `Queued ${r.jobs} enrichment jobs for ${r.creators} creators and refreshed ${r.campaigns} campaigns.`)}
            >
              {busy === "prewarm" ? "Pre-warming" : "Pre-warm demo data"}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void operate("due", "/api/admin/campaigns/run-due", (r) => `Started ${r.started} scheduled campaign refreshes.`)}>
              Run due campaign refreshes
            </Button>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void operate("history", "/api/admin/history/recompute", (r) => `Rebuilt history scores for ${r.creators} creators from their outcome records; ${r.changed} changed.`)}
            >
              Rebuild history scores
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void operate("sweep", "/api/admin/sweep", describeSweep)}>
              Settle stuck work
            </Button>
          </div>
          {opsNote && <div className="mt-2 text-xs text-neutral-600">{opsNote}</div>}
        </Card>

        <Card className="flex items-center justify-between p-4 text-[13px]">
          <div>
            <div className="font-semibold">Force LLM failure</div>
            <div className="text-neutral-500">
              Test switch for AC-MX-3: every model call fails as if the model provider were down, and runs fall back to data scores. Model: {flags.data?.llmModel ?? "…"}
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
