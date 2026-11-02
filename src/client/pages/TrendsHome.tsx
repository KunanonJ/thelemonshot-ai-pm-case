import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Empty, Field, Input, Pill, Select, StatusPill, Td, Th } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { fmtAgo, PLATFORM_LABELS } from "../lib/format";
import { Link } from "../lib/router";
import type { Role, TrendPlatform, TrendRunSummary, TrendTermKind, TrendWatchTerm } from "../types";

const SCOPE =
  "Within-sample signals: every figure describes the public posts pulled in a run, not the platform as a whole. A brief is a draft until a planner approves it.";

const ERRORS: Record<string, string> = {
  term_exists: "That term is already on the watchlist for this category.",
  no_active_terms: "Add at least one active term before pulling.",
  too_many_terms: "Pull up to 10 terms at a time.",
  invalid_term: "Check the term: a hashtag can't contain spaces, and each term needs a platform and a category.",
};

export const usd = (n: number | null) => (n === null ? "Not reported" : `$${n.toFixed(3)}`);

export function TrendsHome({ role }: { role: Role }) {
  const api = useApi();
  const terms = useResource<{ scope: string; terms: TrendWatchTerm[] }>("/api/trends/watchlist");
  // Keep refreshing while a pull is still running
  const runs = useResource<{ scope: string; runs: TrendRunSummary[] }>("/api/trends/runs", (d) =>
    d.runs.some((r) => r.status === "running" || r.status === "queued") ? 4000 : null,
  );
  const canEdit = role !== "viewer";
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<TrendTermKind>("hashtag");
  const [platforms, setPlatforms] = useState<TrendPlatform[]>(["instagram", "tiktok"]);
  const [category, setCategory] = useState("food_snacks");
  const [cap, setCap] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = (terms.data?.terms ?? []).filter((t) => t.active);

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      await Promise.all([terms.reload(), runs.reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? "That didn't go through. Refresh and try again.") : "That didn't go through. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  const togglePlatform = (p: TrendPlatform) => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Trend Monitoring" }]} />}
      actions={
        canEdit && (
          <Button variant="primary" disabled={busy || active.length === 0} onClick={() => void act(() => api("/api/trends/pulls", { method: "POST", body: {} }))}>
            Pull {active.length} active {active.length === 1 ? "term" : "terms"}
          </Button>
        )
      }
    >
      <p className="mb-5 text-[13px] text-neutral-500">
        Watch hashtags and keywords on Instagram and TikTok, pull recent public posts, and turn them into pitch-ready theme briefs.
      </p>
      <Banner tone="neutral" title="Within-sample scope">
        {SCOPE}
      </Banner>
      {error && <div className="mt-4"><Banner tone="red" title={error} /></div>}

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Watchlist</h2>
        {terms.data && terms.data.terms.length === 0 ? (
          <Empty title="No terms watched yet">{canEdit ? "Add a hashtag or keyword below to start a pull." : "Terms that planners add will appear here."}</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-neutral-50/60">
                <tr>
                  <Th>Term</Th>
                  <Th>Kind</Th>
                  <Th>Platforms</Th>
                  <Th>Category</Th>
                  <Th>Posts per pull</Th>
                  <Th>Status</Th>
                  <Th className="text-right">&nbsp;</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {(terms.data?.terms ?? []).map((t) => (
                  <tr key={t.id} className={t.active ? "" : "text-neutral-400"}>
                    <Td className="font-medium">{t.kind === "hashtag" ? `#${t.term}` : t.term}</Td>
                    <Td className="text-neutral-600">{t.kind === "hashtag" ? "Hashtag" : "Keyword"}</Td>
                    <Td className="text-neutral-600">{t.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(", ")}</Td>
                    <Td className="text-neutral-600">{t.category.replace(/_/g, " ")}</Td>
                    <Td className="tabular-nums">{t.postCap}</Td>
                    <Td>{t.active ? <Pill tone="green">Active</Pill> : <Pill>Off</Pill>}</Td>
                    <Td className="text-right">
                      {canEdit && t.active && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`/api/trends/watchlist/${t.id}`, { method: "DELETE" }))}>
                          Turn off
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && (
          <Card className="mt-3 p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
              <Field label="Term">
                <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={kind === "hashtag" ? "snackhack" : "desk snack review"} />
              </Field>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as TrendTermKind)}>
                  <option value="hashtag">Hashtag</option>
                  <option value="keyword">Keyword</option>
                </Select>
              </Field>
              <Field label="Category" hint="Brand category the pitch angles map to">
                <Input value={category} onChange={(e) => setCategory(e.target.value)} />
              </Field>
              <Field label="Posts per pull" hint="Default 30">
                <Input type="number" min={1} max={100} value={cap} onChange={(e) => setCap(e.target.value)} />
              </Field>
              <div className="flex flex-col justify-end gap-1.5">
                <span className="text-[13px] font-medium text-neutral-800">Platforms</span>
                <div className="flex gap-3 text-[13px] text-neutral-700">
                  {(["instagram", "tiktok"] as const).map((p) => (
                    <label key={p} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={platforms.includes(p)} onChange={() => togglePlatform(p)} />
                      {PLATFORM_LABELS[p]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !term.trim() || !category.trim() || platforms.length === 0}
                onClick={() =>
                  void act(
                    () =>
                      api("/api/trends/watchlist", {
                        method: "POST",
                        body: { term, kind, platforms, category, postCap: Number(cap) || 30 },
                      }),
                    () => setTerm(""),
                  )
                }
              >
                Add term
              </Button>
            </div>
          </Card>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold">Pulls and briefs</h2>
        {runs.data && runs.data.runs.length === 0 ? (
          <Empty title="No pulls yet">Pull the active terms to see the first brief.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-neutral-50/60">
                <tr>
                  <Th>Terms</Th>
                  <Th>Status</Th>
                  <Th>Unique posts</Th>
                  <Th>Themes</Th>
                  <Th>Apify cost</Th>
                  <Th className="text-right">Started</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {(runs.data?.runs ?? []).map((r) => (
                  <tr key={r.runId} className="hover:bg-neutral-50/70">
                    <Td>
                      <Link to={`/trends/${r.runId}`} className="font-medium hover:underline">
                        {r.labels.join(", ") || "No terms"}
                      </Link>
                      {r.failedRuns > 0 && <div className="text-xs text-amber-800">{r.failedRuns} term run(s) failed</div>}
                    </Td>
                    <Td>
                      <StatusPill status={r.status} />
                    </Td>
                    <Td className="tabular-nums">{r.uniquePosts ?? "-"}</Td>
                    <Td className="tabular-nums">
                      {r.themes ?? "-"}
                      {r.weakThemes ? <span className="text-neutral-500"> ({r.weakThemes} weak)</span> : null}
                    </Td>
                    <Td className="tabular-nums text-neutral-600">{usd(r.usageUsd)}</Td>
                    <Td className="text-right text-neutral-500">{fmtAgo(r.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
