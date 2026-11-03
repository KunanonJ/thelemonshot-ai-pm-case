import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Pill, SampleDataPill, Spinner, StatusPill, Td, Th } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { fmtAgo, fmtDateTime, PLATFORM_LABELS } from "../lib/format";
import { Link } from "../lib/router";
import type { Role, TrendRunDetail } from "../types";
import { usd } from "./TrendsHome";

// Each flag the brief can carry, in plain words for the planner (FR-TM-3 wording, BR-TM-1, BR-TM-2)
function flagText(flag: string): { text: string; tone: "amber" | "neutral" } {
  const [name, count] = flag.split(":");
  const n = Number(count ?? 1);
  switch (name) {
    case "no_posts":
      return { text: "No posts were pulled for these terms, so there are no themes.", tone: "amber" };
    case "zero_signal_runs":
      return { text: `${n} term run(s) returned no signal in this pull.`, tone: "neutral" };
    case "source_failed":
      return { text: `${n} platform pull(s) failed. The brief covers the other platform where it could.`, tone: "amber" };
    case "weak_signal_themes":
      return { text: `${n} theme(s) have fewer than three supporting posts and are labelled weak signal.`, tone: "neutral" };
    case "narrative_unavailable":
      return { text: "The model was unavailable, so theme names and pitch angles are the plain versions built from the data.", tone: "amber" };
    case "figures_replaced":
      return { text: `${n} figure(s) in the model's wording could not be traced to this pull and were marked TBC.`, tone: "amber" };
    case "platform_wording_removed":
      return { text: `${n} sentence(s) in the model's wording described the platform as a whole and were replaced with the plain version.`, tone: "amber" };
    case "items_dropped":
      return { text: `${n} model item(s) were dropped because they didn't match a theme or a brand category.`, tone: "neutral" };
    default:
      return { text: flag, tone: "neutral" };
  }
}

export function TrendDetail({ role, id }: { role: Role; id: string }) {
  const api = useApi();
  // Keep refreshing while the pull is running or the brief is being written
  const detail = useResource<TrendRunDetail>(`/api/trends/runs/${id}`, (d) => (d.status === "running" || d.pullStatus !== "done" ? 3000 : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = detail.data;
  const canReview = role !== "viewer" && d?.status === "draft";

  async function review(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/trends/runs/${id}/review`, { method: "POST", body: { decision } });
      await detail.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "That didn't go through. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  const crumbs = <Crumbs items={[{ label: "Trend Monitoring", to: "/trends" }, { label: d ? (d.terms.map((t) => t.label).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "Pull") : "Pull" }]} />;
  if (!d) {
    return (
      <Shell role={role} title={crumbs}>
        {detail.error ? <Banner tone="red" title="This brief could not be loaded." /> : <Spinner />}
      </Shell>
    );
  }

  const brief = d.brief;
  const labels = [...new Set(d.terms.map((t) => t.label))];
  return (
    <Shell
      role={role}
      title={crumbs}
      actions={
        <>
          {d.flags?.sampleData === true && <SampleDataPill />}
          {canReview && (
            <>
              <Button variant="danger" disabled={busy} onClick={() => void review("reject")}>
                Reject
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void review("approve")}>
                Approve brief
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill status={d.status} />
        <span className="text-[13px] text-neutral-500">
          Pulled {fmtAgo(d.createdAt)} by {d.createdBy === "system:cron" ? "the schedule" : "a planner"} · Apify cost {usd(d.usageUsd)}
        </span>
        {d.reviewedAt && (
          <span className="text-[13px] text-neutral-500">
            · {d.status} {fmtDateTime(d.reviewedAt)}
          </span>
        )}
      </div>
      <Banner tone="neutral" title="Within-sample scope">
        Every figure here describes the public posts pulled for {labels.join(", ") || "these terms"}, not the platforms as a whole. Each theme links to the posts behind it.
      </Banner>
      {error && <div className="mt-4"><Banner tone="red" title={error === "run_not_in_draft" ? "This brief is no longer a draft." : "That didn't go through."} /></div>}

      {d.status === "failed" && (
        <div className="mt-5">
          <Banner tone="red" title="No brief was written for this pull.">
            {d.error ?? "The pull stopped before it finished."}
          </Banner>
        </div>
      )}

      {!brief && d.status !== "failed" && (
        <Card className="mt-5 flex items-center gap-3 px-4 py-4 text-[13px]">
          <Spinner />
          <div>
            <div className="font-medium">{d.pullStatus === "done" ? "Brief not found" : "Pulling and writing the brief"}</div>
            <div className="text-neutral-500">Each term is pulled on its own. The brief is written once every pull has answered or timed out.</div>
          </div>
        </Card>
      )}

      <section className="mt-5">
        <h2 className="mb-2 text-sm font-semibold">Pull by term</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Term</Th>
                <Th>Platform</Th>
                <Th>Result</Th>
                <Th>Posts used</Th>
                <Th>Items returned</Th>
                <Th>Apify run</Th>
                <Th>Cost</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {d.terms.map((t) => (
                <tr key={t.id} className={t.status === "ok" && t.postCount === 0 ? "bg-neutral-50/60" : ""}>
                  <Td className="font-medium">{t.label}</Td>
                  <Td className="text-neutral-600">{PLATFORM_LABELS[t.platform] ?? t.platform}</Td>
                  <Td>
                    {t.status === "failed" ? (
                      <Pill tone="red" title={t.error ?? undefined}>
                        Failed
                      </Pill>
                    ) : t.status === "running" ? (
                      <Pill tone="blue">Running</Pill>
                    ) : t.postCount === 0 ? (
                      <Pill>No signal in this pull</Pill>
                    ) : (
                      <Pill tone="green">Pulled</Pill>
                    )}
                    {t.note && <div className="mt-1 text-xs text-neutral-500">{t.note}</div>}
                    {t.error && <div className="mt-1 text-xs text-red-700">{t.error}</div>}
                  </Td>
                  <Td className="tabular-nums">{t.postCount ?? "-"}</Td>
                  <Td className="tabular-nums text-neutral-600">{t.itemCount ?? "-"}</Td>
                  <Td className="text-neutral-600">{t.apifyStatus ?? "-"}</Td>
                  <Td className="tabular-nums text-neutral-600">{usd(t.usageUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {brief && (
        <>
          <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card className="px-4 py-3">
              <div className="text-xs text-neutral-500">Unique posts</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{brief.sample.uniquePosts}</div>
              <div className="text-xs text-neutral-500">
                {Object.entries(brief.sample.postsByPlatform)
                  .map(([p, n]) => `${n} ${PLATFORM_LABELS[p] ?? p}`)
                  .join(", ") || "None"}
              </div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-xs text-neutral-500">Found by more than one term</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{brief.sample.duplicatesRemoved}</div>
              <div className="text-xs text-neutral-500">Counted once, by platform post ID</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-xs text-neutral-500">Themes</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{brief.themes.length}</div>
              <div className="text-xs text-neutral-500">{brief.themes.filter((t) => t.weakSignal).length} weak signal</div>
            </Card>
            <Card className="px-4 py-3">
              <div className="text-xs text-neutral-500">Not in any theme</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{brief.sample.otherPosts}</div>
              <div className="text-xs text-neutral-500">Posts pulled but not grouped</div>
            </Card>
          </section>

          {brief.flags.length > 0 && (
            <section className="mt-4 space-y-2">
              {brief.flags.map((f) => {
                const t = flagText(f);
                return (
                  <Banner key={f} tone={t.tone} title={t.text} />
                );
              })}
            </section>
          )}

          {brief.sources.length > 0 && (
            <section className="mt-4 space-y-2">
              {brief.sources.map((s, i) => (
                <div key={i} className={`rounded-md border px-3 py-2 text-[13px] ${s.level === "warning" ? "border-amber-200 bg-amber-50/60 text-amber-900" : "border-neutral-200 bg-neutral-50 text-neutral-700"}`}>
                  {s.text}
                </div>
              ))}
            </section>
          )}

          <section className="mt-6">
            <h2 className="mb-1 text-sm font-semibold">Themes</h2>
            <p className="mb-3 text-xs text-neutral-500">Named by the model from the posts below. Membership, counts and links come from the data.</p>
            {brief.themes.length === 0 ? (
              <Card className="px-4 py-4 text-[13px] text-neutral-600">No theme was formed from these posts. Each theme needs at least two posts that share a hashtag.</Card>
            ) : (
              <div className="space-y-3">
                {brief.themes.map((t) => (
                  <Card key={t.id} className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{t.name}</h3>
                      {t.weakSignal && <Pill tone="amber">Weak signal</Pill>}
                      {t.rising && <Pill tone="green">Rising within this pull</Pill>}
                      <span className="text-xs text-neutral-500">#{t.seedTag}</span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-neutral-700">{t.summary}</p>
                    <div className="mt-2 text-xs text-neutral-500">
                      {t.postCount} of {brief.sample.uniquePosts} unique posts ({t.stats.shareOfPostsPct}%)
                      {t.stats.recentSharePct !== null && ` · ${t.stats.recentPosts} of ${t.stats.datedPosts} dated posts in the newer half of the pulled window`}
                      {t.stats.topThreeEngagementSharePct !== null && ` · top three posts hold ${t.stats.topThreeEngagementSharePct}% of its likes and comments`}
                    </div>
                    {t.pitchAngles.length > 0 && (
                      <ul className="mt-3 space-y-1.5 text-[13px] text-neutral-700">
                        {t.pitchAngles.map((p) => (
                          <li key={p.category}>
                            <span className="font-medium">{p.category.replace(/_/g, " ")}:</span> {p.angle}{" "}
                            <span className="text-[11px] text-neutral-400">{p.source === "model" ? "model" : "template"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-3 border-t border-neutral-100 pt-2">
                      <div className="text-xs font-medium text-neutral-500">Source posts</div>
                      <ul className="mt-1 space-y-1 text-[13px]">
                        {t.sources.map((s) => (
                          <li key={s.postId}>
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-neutral-800 underline decoration-neutral-300 hover:decoration-neutral-700">
                              {PLATFORM_LABELS[s.platform] ?? s.platform} {s.handle ? `@${s.handle}` : "post"}
                            </a>
                            {s.postedAt && <span className="text-neutral-500"> · {fmtDateTime(s.postedAt)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {brief.exemplars.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-semibold">Exemplar posts</h2>
              <Card className="divide-y divide-neutral-100">
                {brief.exemplars.map((e) => (
                  <div key={e.postId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <a href={e.url} target="_blank" rel="noreferrer" className="font-medium text-neutral-800 underline decoration-neutral-300 hover:decoration-neutral-700">
                      {PLATFORM_LABELS[e.platform] ?? e.platform} {e.handle ? `@${e.handle}` : "post"}
                    </a>
                    <span className="text-neutral-500">
                      {e.engagement !== null ? `${e.engagement} likes and comments` : "Engagement not reported"}
                      {e.postedAt ? ` · ${fmtDateTime(e.postedAt)}` : ""}
                    </span>
                  </div>
                ))}
              </Card>
            </section>
          )}
        </>
      )}

      <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Attached to proposals</h2>
          {d.attachedProposals.length === 0 ? (
            <p className="mt-2 text-[13px] text-neutral-500">Not attached yet. An approved brief can be attached from a proposal draft.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-[13px]">
              {d.attachedProposals.map((pid) => (
                <li key={pid}>
                  <Link to={`/proposals/${pid}`} className="hover:underline">
                    Proposal {pid.slice(0, 8)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold">History</h2>
          <ul className="mt-2 space-y-1 text-[13px] text-neutral-600">
            {d.logs.map((l) => (
              <li key={l.id}>
                {fmtDateTime(l.createdAt)}:{" "}
                {l.kind === "decision"
                  ? `${String(l.payload.decision)} by ${l.actor}`
                  : l.kind === "llm"
                    ? l.payload.failure
                      ? "Theme naming could not run"
                      : "Theme naming ran"
                    : l.kind === "inputs"
                      ? "Pull started"
                      : l.kind}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </Shell>
  );
}
