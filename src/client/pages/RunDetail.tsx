import { Fragment, useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Drawer, Pill, SampleDataPill, Spinner, StatCard, StatusPill, Td, Th } from "../components/ui";
import { download, useApi, useResource } from "../lib/api";
import { categoryLabel, FLAG_LABELS, fmtAgo, fmtCompact, fmtDateTime, fmtPct, fmtScore, OBJECTIVE_LABELS, PLATFORM_LABELS } from "../lib/format";
import type { Role, RunDetail as Run, RunItem, Scoring } from "../types";

const byScore = (a: RunItem, b: RunItem) => (b.composite ?? -1) - (a.composite ?? -1);
const FLAG_TONE: Record<string, "amber" | "neutral" | "blue"> = { must_include: "blue", cold_start: "neutral" };

export function RunDetail({ role, id, userId }: { role: Role; id: string; userId: string }) {
  const api = useApi();
  const run = useResource<Run>(`/api/matrix/runs/${id}`, (r) => (r.status === "queued" || r.status === "running" ? 2500 : null));
  const [scoringOpen, setScoringOpen] = useState(false);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canReview = role !== "viewer";

  const r = run.data;
  const title = r?.brief?.brand || "Untitled brief";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await run.reload();
    } catch {
      setError("That didn't go through. Refresh and try again.");
    } finally {
      setBusy(false);
      setSwapFor(null);
    }
  }

  const review = (decision: "approve" | "reject") => act(() => api(`/api/matrix/runs/${id}/review`, { method: "POST", body: { decision } }));
  const swap = (replaceCreatorId: string, withCreatorId: string) =>
    act(() => api(`/api/matrix/runs/${id}/override`, { method: "POST", body: { replaceCreatorId, withCreatorId } }));

  const items = r?.items ?? [];
  const nameOf = (creatorId: string) => items.find((i) => i.creatorId === creatorId)?.creator.displayName ?? creatorId.slice(0, 8);
  const picks = items.filter((i) => i.finalPick).sort(byScore);
  const alternates = items.filter((i) => !i.finalPick && !i.excludedReason).sort(byScore);
  const safety = items.filter((i) => i.excludedReason === "safety_excluded");
  const noData = items.filter((i) => i.excludedReason === "no_data");
  const inFlight = r?.status === "queued" || r?.status === "running";

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creator Matrix", to: "/matrix" }, { label: title }]} />}
      actions={
        r && (
          <>
            {r.flags.sampleData && <SampleDataPill />}
            <Button variant="ghost" onClick={() => setScoringOpen(true)}>
              How scoring works
            </Button>
            {r.status === "draft" && canReview && (
              <>
                <Button disabled={busy} onClick={() => void review("reject")}>
                  Reject
                </Button>
                <Button variant="primary" disabled={busy || picks.length === 0} onClick={() => void review("approve")}>
                  Approve shortlist
                </Button>
              </>
            )}
            {r.status === "approved" && (
              <Button variant="primary" onClick={() => void download(api, `/api/matrix/runs/${id}/export.csv`, `shortlist-${id.slice(0, 8)}.csv`)}>
                Export CSV
              </Button>
            )}
          </>
        )
      }
    >
      {!r ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">{run.error ? `Couldn't load this run (${run.error}).` : <Spinner />}</div>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <StatusPill status={r.status} />
            </div>
            <div className="mt-1 text-[13px] text-neutral-500">
              {r.brief && `${categoryLabel(r.brief.productCategory)} · ${OBJECTIVE_LABELS[r.brief.objective]} · ${r.brief.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}`}
              {" · "}created {fmtAgo(r.createdAt)}
              {r.reviewedAt && ` · reviewed ${fmtDateTime(r.reviewedAt)}`}
            </div>
            {r.brief?.audience && <div className="mt-2 max-w-3xl text-[13px] text-neutral-700">{r.brief.audience}</div>}
          </div>

          {inFlight && (
            <Card className="flex items-center gap-3 px-4 py-4 text-[13px]">
              <Spinner />
              <div>
                <div className="font-medium">{r.status === "queued" ? "Queued" : "Scoring creators"}</div>
                <div className="text-neutral-500">Reading the latest snapshots and asking the model for fit and a rationale. This usually takes under two minutes.</div>
              </div>
            </Card>
          )}
          {r.status === "failed" && <Banner tone="red" title="This run failed">{r.error ?? "Unknown error"}. It is listed under dead letters.</Banner>}
          {error && <Banner tone="red" title={error} />}

          {!inFlight && r.status !== "failed" && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <StatCard label="Shortlisted" value={picks.length} hint="Draft until approved" />
                <StatCard label="Candidates scored" value={r.flags.candidates ?? 0} hint={`${r.flags.poolSize ?? 0} in the pool, cap 40`} />
                <StatCard label="Safety-excluded" value={safety.length} hint="Brand safety under 40" />
                <StatCard label="No usable data" value={noData.length} hint="Listed below with the reason" />
              </div>

              <div className="space-y-2">
                {(r.flags.conflicts?.length ?? 0) > 0 && (
                  <Banner title="Include and exclude conflict">
                    {r.flags.conflicts!.map((c) => `@${c}`).join(", ")} appeared on both lists and {r.flags.conflicts!.length === 1 ? "was" : "were"} excluded.
                  </Banner>
                )}
                {r.flags.thinPool && (
                  <Banner title="Thin pool">Fewer than 10 creators matched. Widen the category or add creators to the roster.</Banner>
                )}
                {r.flags.llmUnavailable && (
                  <Banner title="Rationale unavailable for this run">
                    The model didn't return a usable answer ({r.flags.llmFailure ?? "unknown"}), so every row is ranked on data scores only.
                  </Banner>
                )}
                {r.flags.split && <Banner tone="neutral" title="Scored in two batches">The candidate table was too large for one model call; results were merged by creator.</Banner>}
              </div>

              <section>
                <div className="mb-2 flex items-end justify-between">
                  <h2 className="text-sm font-semibold">Shortlist</h2>
                  {r.status === "draft" && canReview && <span className="text-xs text-neutral-500">Swap any row for an alternate. The original ranking is kept.</span>}
                </div>
                <ShortlistTable
                  rows={picks}
                  nameOf={nameOf}
                  swapFor={swapFor}
                  setSwapFor={r.status === "draft" && canReview ? setSwapFor : null}
                  alternates={alternates}
                  onSwap={(out, into) => void swap(out, into)}
                  busy={busy}
                />
              </section>

              {alternates.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Alternates <span className="font-normal text-neutral-500">({alternates.length})</span>
                  </summary>
                  <div className="mt-2">
                    <ShortlistTable rows={alternates} nameOf={nameOf} swapFor={null} setSwapFor={null} alternates={[]} onSwap={() => {}} busy={busy} dim />
                  </div>
                </details>
              )}

              {(safety.length > 0 || noData.length > 0) && (
                <section className="grid grid-cols-2 gap-3">
                  <Card className="p-4">
                    <h3 className="text-[13px] font-semibold">Safety-excluded ({safety.length})</h3>
                    <ul className="mt-2 space-y-1.5 text-[13px]">
                      {safety.map((i) => (
                        <li key={i.id} className="flex justify-between gap-3">
                          <span>{i.creator.displayName}</span>
                          <span className="text-neutral-500">brand safety {i.dims?.brandSafety}</span>
                        </li>
                      ))}
                      {safety.length === 0 && <li className="text-neutral-500">None</li>}
                    </ul>
                  </Card>
                  <Card className="p-4">
                    <h3 className="text-[13px] font-semibold">No usable data ({noData.length})</h3>
                    <ul className="mt-2 space-y-1.5 text-[13px]">
                      {noData.map((i) => (
                        <li key={i.id} className="flex justify-between gap-3">
                          <span>{i.creator.displayName}</span>
                          <span className="text-neutral-500">no snapshot on the requested platforms</span>
                        </li>
                      ))}
                      {noData.length === 0 && <li className="text-neutral-500">None</li>}
                    </ul>
                  </Card>
                </section>
              )}

              {r.logs.length > 0 && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold">Decisions</h2>
                  <ul className="space-y-1 text-[13px] text-neutral-600">
                    {r.logs.map((l) => (
                      <li key={l.id}>
                        <span className="text-neutral-400">{fmtDateTime(l.createdAt)}</span> · {l.actor === userId ? "You" : "A teammate"}{" "}
                        {l.kind === "override" &&
                          `swapped ${nameOf((l.payload.replaced as { creatorId: string }).creatorId)} for ${nameOf((l.payload.with as { creatorId: string }).creatorId)}`}
                        {l.kind === "decision" && `${l.payload.decision === "approve" ? "approved" : "rejected"} the shortlist`}
                        {l.kind === "export" && "exported the shortlist"}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
      <ScoringDrawer open={scoringOpen} onClose={() => setScoringOpen(false)} objective={r?.brief?.objective} />
    </Shell>
  );
}

function ShortlistTable(props: {
  rows: RunItem[];
  nameOf: (creatorId: string) => string;
  swapFor: string | null;
  setSwapFor: ((id: string | null) => void) | null;
  alternates: RunItem[];
  onSwap: (out: string, into: string) => void;
  busy: boolean;
  dim?: boolean;
}) {
  const { rows, nameOf, swapFor, setSwapFor, alternates, onSwap, busy, dim } = props;
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <table className="w-full">
        <thead className="border-b border-neutral-200 bg-neutral-50/60">
          <tr>
            <Th className="w-10">#</Th>
            <Th>Creator</Th>
            <Th className="w-16 text-right">Score</Th>
            <Th className="w-44">Fit (model)</Th>
            <Th className="w-52">Data scores</Th>
            <Th className="w-28">Reach</Th>
            <Th className="w-32">Data quality</Th>
            {setSwapFor && <Th className="w-16" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((row, i) => (
            <Fragment key={row.id}>
              <tr className={cx(dim && "text-neutral-600")}>
                <Td className="text-neutral-400">{i + 1}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{row.creator.displayName}</span>
                    {row.replacesCreatorId && <Pill tone="blue">Swapped in for {nameOf(row.replacesCreatorId)}</Pill>}
                    {!row.finalPick && row.recommended && <Pill>Removed by planner</Pill>}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {[row.creator.instagram && `IG @${row.creator.instagram}`, row.creator.tiktok && `TT @${row.creator.tiktok}`, row.creator.youtube && `YT @${row.creator.youtube}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className={cx("mt-1 max-w-xl text-xs leading-relaxed", row.rationale ? "text-neutral-600" : "text-amber-700")}>
                    {row.rationale ?? "Rationale unavailable"}
                  </div>
                </Td>
                <Td className="text-right text-base font-semibold tabular-nums">{fmtScore(row.composite)}</Td>
                <Td>
                  <Mini label="Audience" value={row.dims?.audienceFit} />
                  <Mini label="Brand safety" value={row.dims?.brandSafety} />
                  <Mini label="Creative" value={row.dims?.creativeFit} />
                </Td>
                <Td>
                  <Mini label="Engagement" value={row.components.engagement} />
                  <Mini label="Reach" value={row.components.reach} />
                  <Mini label="Category" value={row.components.categoryFit} />
                  <Mini label="History" value={row.components.history} empty="none yet" />
                </Td>
                <Td>
                  {Object.entries(row.features.perPlatform ?? {}).map(([p, f]) => (
                    <div key={p} className="text-xs tabular-nums">
                      <span className="text-neutral-500">{PLATFORM_LABELS[p]?.slice(0, 2).toUpperCase()}</span> {fmtCompact(f.followers)}
                      <span className="text-neutral-400"> · ER {fmtPct(f.engagementRate)}</span>
                    </div>
                  ))}
                </Td>
                <Td>
                  <div className="text-xs tabular-nums">
                    {Math.round(row.completeness)}% complete
                    {row.stalenessDays !== null && <span className="text-neutral-400"> · {row.stalenessDays}d old</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {row.flags
                      .filter((f) => f !== "rationale_unavailable")
                      .map((f) => (
                        <Pill key={f} tone={FLAG_TONE[f] ?? "amber"}>
                          {FLAG_LABELS[f] ?? f}
                        </Pill>
                      ))}
                  </div>
                </Td>
                {setSwapFor && (
                  <Td className="text-right">
                    <button
                      className="text-xs text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => setSwapFor(swapFor === row.creatorId ? null : row.creatorId)}
                    >
                      {swapFor === row.creatorId ? "Cancel" : "Swap"}
                    </button>
                  </Td>
                )}
              </tr>
              {swapFor === row.creatorId && (
                <tr className="bg-neutral-50/70">
                  <td colSpan={8} className="px-3 py-3">
                    <div className="mb-2 text-xs text-neutral-500">Replace {row.creator.displayName} with:</div>
                    <div className="flex flex-wrap gap-2">
                      {alternates.slice(0, 10).map((a) => (
                        <Button key={a.id} size="sm" disabled={busy} onClick={() => onSwap(row.creatorId, a.creatorId)}>
                          {a.creator.displayName} · {fmtScore(a.composite)}
                        </Button>
                      ))}
                      {alternates.length === 0 && <span className="text-xs text-neutral-500">No alternates left in this run.</span>}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-[13px] text-neutral-500">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Mini({ label, value, empty = "–" }: { label: string; value: number | null | undefined; empty?: string }) {
  return (
    <div className="flex justify-between gap-2 text-xs tabular-nums">
      <span className="text-neutral-500">{label}</span>
      <span className={value === null || value === undefined ? "text-neutral-400" : ""}>{value === null || value === undefined ? empty : Math.round(value)}</span>
    </div>
  );
}

function ScoringDrawer({ open, onClose, objective }: { open: boolean; onClose: () => void; objective?: string }) {
  const scoring = useResource<Scoring>(open ? "/api/matrix/scoring" : null);
  const s = scoring.data;
  const weights = s && objective ? s.weights[objective] : null;
  return (
    <Drawer open={open} title="How scoring works" onClose={onClose}>
      {!s ? (
        <Spinner />
      ) : (
        <div className="space-y-6 text-[13px]">
          <p className="text-neutral-600">
            Code does the arithmetic, the model judges fit, and a person makes the call. The score blends the components below with weights set by the brief's
            objective. Missing components drop out and the others are rescaled, so a missing value never counts as zero.
          </p>
          {weights && (
            <div>
              <div className="mb-2 font-medium">Weights for {OBJECTIVE_LABELS[objective!]}</div>
              <div className="space-y-1.5">
                {Object.entries(weights)
                  .sort((a, b) => b[1] - a[1])
                  .map(([c, w]) => (
                    <div key={c} className="flex items-center gap-3">
                      <span className="w-28 text-neutral-600">{s.components[c]?.label}</span>
                      <div className="h-1.5 flex-1 rounded bg-neutral-100">
                        <div className="h-1.5 rounded bg-neutral-800" style={{ width: `${w * 100}%` }} />
                      </div>
                      <span className="w-9 text-right tabular-nums">{Math.round(w * 100)}%</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
          <div className="space-y-3">
            {Object.entries(s.components).map(([c, info]) => (
              <div key={c}>
                <div className="flex items-center gap-2 font-medium">
                  {info.label} <Pill tone={info.source === "llm" ? "blue" : "neutral"}>{info.source === "llm" ? "Model" : "Data"}</Pill>
                </div>
                <div className="text-neutral-600">{info.description}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 font-medium">Rules around the score</div>
            <ul className="list-disc space-y-1 pl-4 text-neutral-600">
              <li>Up to {s.rules.candidateCap} matching creators are scored; fewer than {s.rules.thinPool} triggers a thin-pool warning.</li>
              <li>Brand safety under {s.rules.brandSafetyFloor} removes a creator whatever the score.</li>
              <li>Data completeness under {s.rules.confidenceThreshold}% shows a low-confidence flag.</li>
              <li>Must-exclude always wins over must-include.</li>
              <li>If the model fails, the run still ships on data scores and every row says the rationale is unavailable.</li>
            </ul>
          </div>
          <div className="text-xs text-neutral-400">Scoring version {s.version}</div>
        </div>
      )}
    </Drawer>
  );
}
