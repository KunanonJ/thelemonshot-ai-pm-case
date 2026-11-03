import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Drawer, Input, Pill, SampleDataPill, Spinner, StatCard, StatusPill, Td, Th } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { ACTION_LABELS, DELTA_LABELS, fmtAgo, fmtCompact, fmtDate, fmtDateTime, fmtPct, fmtSignedPct, PLATFORM_LABELS, TREND_LABELS } from "../lib/format";
import { Link } from "../lib/router";
import type { CampaignDetail as Campaign, CampaignDigest, Delta, DigestDeltas, OutcomeRow, PostDelta, Role } from "../types";

const STATUS_TONE = { active: "blue", closed: "green", archived: "neutral" } as const;
const ERRORS: Record<string, string> = {
  refresh_cooldown: "A refresh ran less than five minutes ago. Try again shortly.",
  campaign_not_active: "This campaign is closed.",
  no_posts_to_refresh: "Every tracked post is unavailable, so there is nothing to refresh.",
  summary_changed: "The numbers changed since this summary was shown (a refresh landed). Review them again.",
  close_before_archiving: "Close the campaign before archiving it.",
};

// The delta a number rests on, in one line: "+50% (1.5K vs 1K)"
function DeltaText({ d, er }: { d: Delta | null; er?: boolean }) {
  if (!d) return <span className="text-neutral-400">–</span>;
  const fmt = (v: number) => (er ? fmtPct(v) : fmtCompact(v));
  return (
    <span className="tabular-nums">
      <span className={cx(d.pct > 0 ? "text-emerald-700" : d.pct < 0 ? "text-red-700" : "")}>{fmtSignedPct(d.pct)}</span>
      <span className="text-neutral-400">
        {" "}
        ({fmt(d.value)} vs {fmt(d.reference)})
      </span>
    </span>
  );
}

export function CampaignDetail({ role, id, userId }: { role: Role; id: string; userId: string }) {
  const api = useApi();
  const campaign = useResource<Campaign>(`/api/campaigns/${id}`, (c) => (c.refreshes.some((r) => r.status === "running") ? 4000 : null));
  const [digestId, setDigestId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const c = campaign.data;
  const canEdit = role !== "viewer";
  const running = c?.refreshes.find((r) => r.status === "running");

  async function act(fn: () => Promise<unknown>) {
    setActing(true);
    setError(null);
    try {
      await fn();
      await campaign.reload();
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? "That didn't go through. Refresh and try again.") : "That didn't go through.");
    } finally {
      setActing(false);
    }
  }

  const d = c?.deltas;
  const totalViews = d?.posts.reduce((s, p) => s + (p.latest?.views ?? 0), 0) ?? 0;

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Optimization", to: "/campaigns" }, { label: c?.name ?? "Campaign" }]} />}
      actions={
        c && (
          <>
            {c.sampleData && <SampleDataPill />}
            {c.status === "active" && canEdit && (
              <>
                <Button disabled={acting || Boolean(running)} onClick={() => void act(() => api(`/api/campaigns/${id}/refresh`, { method: "POST", body: {} }))}>
                  {running ? "Refreshing" : "Refresh now"}
                </Button>
                <Button variant="primary" disabled={acting} onClick={() => setClosing(true)}>
                  Close campaign
                </Button>
              </>
            )}
            {c.status === "closed" && canEdit && (
              <Button disabled={acting} onClick={() => void act(() => api(`/api/campaigns/${id}/archive`, { method: "POST", body: {} }))}>
                Archive
              </Button>
            )}
          </>
        )
      }
    >
      {!c || !d ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">{campaign.error ? `Couldn't load this campaign (${campaign.error}).` : <Spinner />}</div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{c.name}</h1>
              <Pill tone={STATUS_TONE[c.status]}>{c.status[0]!.toUpperCase() + c.status.slice(1)}</Pill>
            </div>
            <div className="mt-1 text-[13px] text-neutral-500">
              {c.brand} · {fmtDate(c.startsAt)} to {fmtDate(c.endsAt)}
              {c.matrixRun && (
                <>
                  {" · "}
                  <Link to={`/matrix/runs/${c.matrixRun.id}`} className="hover:underline">
                    shortlist {c.matrixRun.id.slice(0, 8)}
                  </Link>
                </>
              )}
            </div>
          </div>
          <Banner tone="neutral" title="Organic performance scope">
            {c.scope}
          </Banner>
          {running && (
            <Card className="flex items-center gap-3 px-4 py-4 text-[13px]">
              <Spinner />
              <div>
                <div className="font-medium">Refreshing {running.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</div>
                <div className="text-neutral-500">
                  {running.done.length + running.failed.length} of {running.platforms.length} sources answered. The digest is written once all have.
                </div>
              </div>
            </Card>
          )}
          {error && <Banner tone="red" title={error} />}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Posts tracked" value={d.posts.length} hint={d.unavailable.length ? `${d.unavailable.length} unavailable` : "All available"} />
            <StatCard label="Views" value={fmtCompact(totalViews)} hint="Latest, across tracked posts" />
            <StatCard label="Median engagement" value={fmtPct(d.campaignMedianEr)} hint="Across tracked posts" />
            <StatCard label="Last refresh" value={fmtAgo(c.lastRefreshAt)} hint={c.status === "active" ? (Date.now() <= c.endsAt ? "Daily during the flight" : "Weekly after it") : "Closed"} />
          </div>

          <Card className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-neutral-500">Where it stands now</div>
                <div className="mt-1 text-[15px] font-medium">{d.verdict.text}</div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-1.5 text-xs text-neutral-500">Digests</div>
              {c.digests.length === 0 ? (
                <div className="text-[13px] text-neutral-500">The first digest is written after the first refresh finishes.</div>
              ) : (
                <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                  {c.digests.map((g) => (
                    <li key={g.runId} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                      <div className="min-w-0 flex-1 truncate">
                        <span className="text-neutral-500">{fmtDateTime(g.createdAt)}</span> · <span>{g.verdict?.text ?? "No verdict"}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {g.flags.includes("narrative_unavailable") && <Pill tone="amber">Narrative unavailable</Pill>}
                        <StatusPill status={g.status} />
                        <Button size="sm" variant="ghost" onClick={() => setDigestId(g.runId)}>
                          Open
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Tracked posts</h2>
            <PostsTable posts={d.posts} />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Creators</h2>
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <table className="w-full">
                <thead className="border-b border-neutral-200 bg-neutral-50/60">
                  <tr>
                    <Th>Creator</Th>
                    <Th>Posts</Th>
                    <Th>Views</Th>
                    <Th>Views vs baseline</Th>
                    <Th>Median ER</Th>
                    <Th>ER vs campaign median</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {d.creators.map((cr) => (
                    <tr key={cr.creatorId}>
                      <Td className="font-medium">{cr.creatorName}</Td>
                      <Td className="tabular-nums">{cr.posts}</Td>
                      <Td className="tabular-nums">{fmtCompact(cr.views)}</Td>
                      <Td>
                        <DeltaText d={cr.vsBaseline} />
                      </Td>
                      <Td className="tabular-nums">{fmtPct(cr.medianEr)}</Td>
                      <Td>
                        <DeltaText d={cr.vsPeer} er />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {c.outcome && <OutcomeCard outcome={c.outcome} />}

          {c.actions.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Actions taken</h2>
              <ul className="space-y-1 text-[13px] text-neutral-700">
                {c.actions.map((a) => (
                  <li key={a.id}>
                    <span className="text-neutral-400">{fmtDateTime(a.createdAt)}</span> · {a.actor === userId ? "You" : "A teammate"}: {a.note}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {c && digestId && <DigestDrawer campaignId={id} runId={digestId} canEdit={canEdit} onClose={() => setDigestId(null)} onChanged={() => void campaign.reload()} />}
      {c && closing && (
        <CloseDrawer
          campaignId={id}
          onClose={() => setClosing(false)}
          onClosed={() => {
            setClosing(false);
            void campaign.reload();
          }}
        />
      )}
    </Shell>
  );
}

function PostsTable({ posts }: { posts: PostDelta[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full">
        <thead className="border-b border-neutral-200 bg-neutral-50/60">
          <tr>
            <Th>Post</Th>
            <Th>Views</Th>
            <Th>Likes</Th>
            <Th>Comments</Th>
            <Th>Shares</Th>
            <Th>ER</Th>
            <Th>Vs baseline</Th>
            <Th>Vs peers</Th>
            <Th>Trend</Th>
            <Th>Data</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {posts.map((p) => {
            const m = p.latest;
            // FR-CO-2: a metric the source doesn't provide reads "not reported", never an estimate
            const cell = (v: number | null | undefined, key: string) =>
              p.notReported.includes(key) ? <span className="text-xs text-neutral-400">not reported</span> : <span className="tabular-nums">{fmtCompact(v)}</span>;
            return (
              <tr key={p.postId} className={cx(p.state === "unavailable" && "bg-neutral-50/70 text-neutral-500")}>
                <Td>
                  <a href={p.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {p.creatorName}
                  </a>
                  <div className="text-xs text-neutral-500">{PLATFORM_LABELS[p.platform]}</div>
                </Td>
                <Td>{m ? cell(m.views, "views") : "–"}</Td>
                <Td>{m ? cell(m.likes, "likes") : "–"}</Td>
                <Td>{m ? cell(m.comments, "comments") : "–"}</Td>
                <Td>{m ? cell(m.shares, "shares") : "–"}</Td>
                <Td className="tabular-nums">{fmtPct(m?.er)}</Td>
                <Td>
                  <DeltaText d={p.vsBaseline.views} />
                </Td>
                <Td>
                  <DeltaText d={p.vsPeer.er} er />
                </Td>
                <Td className="text-xs">{TREND_LABELS[p.trend]}</Td>
                <Td>
                  {p.state === "unavailable" ? (
                    <Pill tone="amber" title={p.unavailableReason ?? undefined}>
                      Unavailable
                    </Pill>
                  ) : p.state === "missing" ? (
                    <Pill tone="amber">Not in last refresh</Pill>
                  ) : (
                    <span className="text-xs text-neutral-500">{m ? fmtAgo(m.fetchedAt) : "No data yet"}</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OutcomeCard({ outcome }: { outcome: NonNullable<Campaign["outcome"]> }) {
  const wb = outcome.writeBack;
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Outcome written back</h2>
      <p className="mt-0.5 text-xs text-neutral-500">
        Outcome scoring {wb.outcomeVersion}, history scoring {wb.historyVersion}. The Creator Matrix reads the new history scores on its next run.
      </p>
      <table className="mt-3 w-full">
        <thead>
          <tr>
            <Th>Creator</Th>
            <Th>Outcome score</Th>
            <Th>History before</Th>
            <Th>History after</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {outcome.rows.map((r) => {
            const h = wb.creators.find((x) => x.creatorId === r.creatorId);
            return (
              <tr key={r.creatorId}>
                <Td className="font-medium">{r.creatorName}</Td>
                <Td className="tabular-nums">{r.outcomeScore ?? <span className="text-xs text-neutral-400">not enough data</span>}</Td>
                <Td className="tabular-nums">{h ? (h.before ?? "none yet") : "–"}</Td>
                <Td className="tabular-nums font-medium">{h?.after ?? "–"}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ---------- digest (FR-CO-4) ----------

function DigestDrawer({ campaignId, runId, canEdit, onClose, onChanged }: { campaignId: string; runId: string; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const api = useApi();
  const digest = useResource<CampaignDigest>(`/api/campaigns/${campaignId}/digests/${runId}`);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const g = digest.data;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await digest.reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const byPost = (d: DigestDeltas) => new Map(d.posts.map((p) => [p.postId, p]));
  const nameOf = (d: DigestDeltas, ref: string) => {
    const p = d.posts.find((x) => x.postId === ref);
    if (p) return `${p.creatorName} (${PLATFORM_LABELS[p.platform]})`;
    return d.creators.find((x) => x.creatorId === ref)?.creatorName ?? ref;
  };

  return (
    <Drawer open title="Campaign digest" onClose={onClose} wide>
      {!g ? (
        <Spinner />
      ) : (
        <div className="space-y-6 text-[13px]">
          <div className="flex items-center justify-between">
            <div className="text-xs text-neutral-500">
              {fmtDateTime(g.createdAt)} · <StatusPill status={g.status} />
            </div>
            {g.status === "draft" && canEdit && (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void act(() => api(`/api/campaigns/${campaignId}/digests/${runId}/review`, { method: "POST", body: { decision: "reject" } }))}>
                  Reject
                </Button>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => api(`/api/campaigns/${campaignId}/digests/${runId}/review`, { method: "POST", body: { decision: "approve" } }))}>
                  Approve digest
                </Button>
              </div>
            )}
          </div>

          <div>
            <div className="text-xs text-neutral-500">Verdict</div>
            <div className="mt-1 text-base font-semibold">{g.deltas.verdict.text}</div>
            {g.narrative ? (
              <p className="mt-2 text-neutral-700">{g.narrative.headline}</p>
            ) : (
              <div className="mt-3">
                {/* AC-CO-4: the deterministic sections stand on their own */}
                <Banner title="Narrative unavailable">
                  {g.llmFailure === "no_data" ? "No metrics yet, so there is nothing to interpret." : "The model didn't return a usable answer, so hypotheses and recommendations are missing. The numbers below are complete."}
                </Banner>
              </div>
            )}
          </div>

          <DigestTable title="Winners" ids={g.deltas.winners} posts={byPost(g.deltas)} empty="No post is more than 10% ahead." />
          <DigestTable title="Losers" ids={g.deltas.losers} posts={byPost(g.deltas)} empty="No post is more than 10% behind." />

          {g.deltas.unavailable.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Lost from tracking</h3>
              <ul className="space-y-1 text-neutral-700">
                {g.deltas.unavailable.map((pid) => {
                  const p = byPost(g.deltas).get(pid)!;
                  return (
                    <li key={pid}>
                      {p.creatorName} ({PLATFORM_LABELS[p.platform]}): {p.unavailableReason ?? "unavailable"}. Last numbers kept: {fmtCompact(p.latest?.views)} views.
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {g.narrative && (
            <>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Hypotheses</h3>
                {g.narrative.hypotheses.length === 0 && <div className="text-neutral-500">None offered.</div>}
                <ul className="space-y-2">
                  {g.narrative.hypotheses.map((h, i) => (
                    <li key={i} className="flex gap-2">
                      <Pill>Hypothesis</Pill>
                      <span>
                        {h.text} <span className="text-neutral-400">({h.refs.map((r) => nameOf(g.deltas, r)).join(", ")})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Recommended adjustments</h3>
                {g.narrative.recommendations.length === 0 && <div className="text-neutral-500">None that passed the guardrails.</div>}
                <div className="space-y-3">
                  {g.narrative.recommendations.map((r, i) => {
                    const logged = g.actions.filter((a) => a.recommendation === i);
                    return (
                      <div key={i} className="rounded-lg border border-neutral-200 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{ACTION_LABELS[r.action] ?? r.action}</span>
                          <span className="text-neutral-500">· {nameOf(g.deltas, r.targetId)}</span>
                        </div>
                        <div className="mt-1 text-xs text-neutral-500">
                          {DELTA_LABELS[r.delta] ?? r.delta}:{" "}
                          {typeof r.motivating === "string" ? TREND_LABELS[r.motivating] : <DeltaText d={r.motivating} er={r.delta.endsWith(".er")} />}
                        </div>
                        <p className="mt-1.5 text-neutral-800">{r.text}</p>
                        {logged.map((a) => (
                          <div key={a.id} className="mt-1 text-xs text-neutral-600">
                            Action logged {fmtDateTime(a.createdAt)}: {a.note}
                          </div>
                        ))}
                        {canEdit && (
                          <div className="mt-2 flex gap-2">
                            <Input value={notes[i] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [i]: e.target.value }))} placeholder="Log what you did, e.g. booked a second post" />
                            <Button
                              size="sm"
                              disabled={busy || !(notes[i] ?? "").trim()}
                              onClick={() =>
                                void act(async () => {
                                  await api(`/api/campaigns/${campaignId}/actions`, { method: "POST", body: { digestRunId: runId, recommendation: i, note: notes[i]!.trim() } });
                                  setNotes((n) => ({ ...n, [i]: "" }));
                                })
                              }
                            >
                              Log action
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <div className="border-t border-neutral-100 pt-3 text-xs text-neutral-500">
            <div className="font-medium text-neutral-700">Data freshness</div>
            {Object.entries(g.freshness.lastData).map(([platform, at]) => (
              <div key={platform}>
                {PLATFORM_LABELS[platform]}: last data {fmtDateTime(at)}
              </div>
            ))}
            {g.freshness.failed.map((f) => (
              <div key={f.platform} className="text-amber-800">
                {PLATFORM_LABELS[f.platform]} didn't refresh this time ({f.error}); its posts show their last-good numbers.
              </div>
            ))}
            {g.flags.filter((f) => !f.startsWith("narrative_unavailable")).length > 0 && (
              <div className="mt-1">Guardrails: {g.flags.filter((f) => !f.startsWith("narrative_unavailable")).join(", ")}</div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function DigestTable({ title, ids, posts, empty }: { title: string; ids: string[]; posts: Map<string, PostDelta>; empty: string }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {ids.length === 0 ? (
        <div className="text-neutral-500">{empty}</div>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <Th>Post</Th>
              <Th>Views vs baseline</Th>
              <Th>ER vs baseline</Th>
              <Th>Views vs peers</Th>
              <Th>ER vs peers</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {ids.map((id) => {
              const p = posts.get(id)!;
              return (
                <tr key={id}>
                  <Td>
                    {p.creatorName} <span className="text-xs text-neutral-500">{PLATFORM_LABELS[p.platform]}</span>
                  </Td>
                  <Td>
                    <DeltaText d={p.vsBaseline.views} />
                  </Td>
                  <Td>
                    <DeltaText d={p.vsBaseline.er} er />
                  </Td>
                  <Td>
                    <DeltaText d={p.vsPeer.views} />
                  </Td>
                  <Td>
                    <DeltaText d={p.vsPeer.er} er />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- closing write-back (FR-CO-7) ----------

function CloseDrawer({ campaignId, onClose, onClosed }: { campaignId: string; onClose: () => void; onClosed: () => void }) {
  const api = useApi();
  const preview = useResource<{ rows: OutcomeRow[]; hash: string; outcomeVersion: string; historyVersion: string }>(`/api/campaigns/${campaignId}/close-preview`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;

  async function confirm() {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/campaigns/${campaignId}/close`, { method: "POST", body: { hash: p.hash } });
      onClosed();
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? "Couldn't close the campaign.") : "Couldn't close the campaign.");
      await preview.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open title="Close campaign" onClose={onClose} wide>
      {!p ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-neutral-600">
            Closing writes each creator's outcome to their record and updates the history score the Creator Matrix uses. It can't be undone, and the campaign
            can then only be archived, never deleted.
          </p>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Creator</Th>
                <Th>Posts</Th>
                <Th>Views</Th>
                <Th>Baseline</Th>
                <Th>Median ER</Th>
                <Th>Campaign median</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {p.rows.map((r) => (
                <tr key={r.creatorId}>
                  <Td className="font-medium">{r.creatorName}</Td>
                  <Td className="tabular-nums">{r.posts}</Td>
                  <Td className="tabular-nums">{fmtCompact(r.views)}</Td>
                  <Td className="tabular-nums">{fmtCompact(r.baselineViews)}</Td>
                  <Td className="tabular-nums">{fmtPct(r.medianEr)}</Td>
                  <Td className="tabular-nums">{fmtPct(r.peerMedianEr)}</Td>
                  <Td className="tabular-nums font-medium">{r.outcomeScore ?? <span className="text-xs font-normal text-neutral-400">not enough data</span>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            An outcome of 50 means the creator performed as expected: engagement against the campaign median, and views against baseline where one was set. A
            creator's history score is the average of all their outcomes, pulled toward 50 while there are only a few ({p.outcomeVersion}, {p.historyVersion}).
          </div>
          {error && <Banner tone="red" title={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
              Confirm and write back
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
