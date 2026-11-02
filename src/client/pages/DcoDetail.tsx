import { useEffect, useState, type ReactNode } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Empty, Pill, Spinner, StatusPill } from "../components/ui";
import { ApiError, useApi, useDownload, useResource } from "../lib/api";
import { useAuthBridge } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import type { DcoCopyView, DcoItemStatus, DcoRunDetail, DcoSegmentView, DcoVisualView, Role } from "../types";
import { fmtBytes, GoverningRule } from "./DcoHome";

type Post = (path: string, body?: unknown) => void;
type Tone = "neutral" | "blue" | "green" | "red";

const isBusy = (s: DcoItemStatus) => s === "pending" || s === "generating";
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const ITEM_TONE: Record<DcoItemStatus, Tone> = { pending: "neutral", generating: "blue", ready: "green", failed: "red" };
const ITEM_LABEL: Record<DcoItemStatus, string> = { pending: "Pending", generating: "Generating", ready: "Ready", failed: "Failed" };

const FALLBACK = "That didn't go through. Refresh and try again.";
const ERRORS: Record<string, string> = {
  not_ready: "That variant isn't ready for review yet.",
  not_failed: "Only a failed item can be retried.",
  run_not_in_draft: "This job is no longer a draft, so it can't be changed.",
  no_approved_visual: "Approve at least one visual before approving the job.",
  items_pending: "Wait for generation to finish before approving the job.",
  export_requires_approval: "Approve the job before exporting.",
  not_found: "This job wasn't found.",
  forbidden: "Your role can't change variant jobs.",
};
const failureText = (e: unknown) => (e instanceof ApiError ? (ERRORS[e.code] ?? FALLBACK) : FALLBACK);

// Guard flags on a copy option, in plain words; unknown flags are shown as written
export function flagLabel(flag: string): string {
  const [kind, value = ""] = flag.split(/:(.*)/s);
  const n = Number(value);
  if (kind === "figures_replaced") return `${n} ${plural(n, "figure", "figures")} set to TBC`;
  if (kind === "placeholder_replaced") return `${n} ${plural(n, "placeholder", "placeholders")} set to TBC`;
  if (kind === "superlatives") return "Check wording: superlatives";
  if (kind === "avoid") return `Mentions a topic to avoid: ${value}`;
  if (kind === "fewer_options") return `Only ${n} options returned`;
  return flag;
}

const flagTone = (flag: string): "amber" | "red" => (flag.startsWith("avoid:") ? "red" : "amber");

function eventLabel(kind: string): string {
  const text = kind.replace(/[_.:-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Images need the auth header, so they are fetched and shown through an object URL that is revoked when replaced
function useAuthedImage(path: string | null, version: string): { url: string | null; failed: boolean } {
  const { getToken } = useAuthBridge();
  const [loaded, setLoaded] = useState<{ key: string; url: string | null }>({ key: "", url: null });
  const key = path ? `${path}#${version}` : null;

  useEffect(() => {
    if (!path || !key) return;
    const src: string = path;
    const id: string = key;
    let live = true;
    let created: string | null = null;
    void (async () => {
      try {
        const token = await getToken();
        const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const blob = res.ok ? await res.blob() : null;
        if (!live) return;
        created = blob ? URL.createObjectURL(blob) : null;
        setLoaded({ key: id, url: created });
      } catch {
        if (live) setLoaded({ key: id, url: null });
      }
    })();
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path, key, getToken]);

  const settled = key !== null && loaded.key === key;
  return { url: settled ? loaded.url : null, failed: settled && loaded.url === null };
}

export function DcoDetail({ role, id }: { role: Role; id: string; userId: string }) {
  const api = useApi();
  const downloadFile = useDownload();
  // Poll while anything is still generating, so results appear without a refresh
  const run = useResource<DcoRunDetail>(`/api/dco/runs/${id}`, (d) =>
    d.status === "queued" || d.status === "running" || d.visuals.some((v) => isBusy(v.status)) || d.segments.some((s) => isBusy(s.status)) ? 3000 : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const d = run.data;
  const canAct = role !== "viewer";

  async function act(fn: () => Promise<unknown>) {
    setActing(true);
    setError(null);
    try {
      await fn();
      await run.reload();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setActing(false);
    }
  }

  const post: Post = (path, body = {}) => void act(() => api(`/api/dco/runs/${id}${path}`, { method: "POST", body }));
  const exportPack = () => void act(() => downloadFile(`/api/dco/runs/${id}/export.zip`, `dco-pack-${id.slice(0, 8)}.zip`));

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creative Variants", to: "/dco" }, { label: d?.brief.brand || "Variant job" }]} />}
      actions={d && <StatusPill status={d.status} />}
    >
      {!d ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">{run.error ? `Couldn't load this job (${run.error}).` : <Spinner />}</div>
      ) : (
        <div className="space-y-6">
          <div className="min-w-0">
            <h1 className="break-words text-lg font-semibold tracking-tight">{d.brief.brand}</h1>
            <p className="break-words text-[13px] text-neutral-500">{d.brief.product}</p>
          </div>
          <Banner tone="neutral" title="Draft until a person approves it." />
          <GoverningRule />
          {error && <Banner tone="red" title={error} />}
          <BriefSection run={d} />
          <VisualsSection run={d} canAct={canAct} acting={acting} onPost={post} />
          <CopySection run={d} canAct={canAct} acting={acting} onPost={post} />
          <ReviewSection run={d} canAct={canAct} acting={acting} onPost={post} onExport={exportPack} />
          <ActivitySection events={d.events} />
        </div>
      )}
    </Shell>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="break-words text-[13px] text-neutral-900">{value}</dd>
    </div>
  );
}

function BriefSection({ run }: { run: DcoRunDetail }) {
  const b = run.brief;
  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <Card className="min-w-0 space-y-4 p-4 lg:col-span-2">
        <h2 className="text-sm font-semibold">Brief</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Info label="Brand" value={b.brand} />
          <Info label="Product" value={b.product} />
          <Info label="Offer" value={b.offer || "No offer given"} />
          <Info label="Copy options per segment" value={b.copyPerSegment} />
        </dl>
        {b.brandVoice && (
          <dl className="grid gap-3">
            <Info label="Brand voice notes" value={b.brandVoice} />
          </dl>
        )}
        <div>
          <div className="text-xs text-neutral-500">Segments</div>
          <ul className="mt-1 space-y-2">
            {b.segments.map((s, i) => (
              <li key={i} className="min-w-0 text-[13px]">
                <span className="break-words font-medium">{s.name}</span>
                {s.note && <div className="break-words text-xs text-neutral-500">{s.note}</div>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs text-neutral-500">Prohibited claims</div>
          {b.prohibitedClaims.length > 0 ? (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px]">
              {b.prohibitedClaims.map((c, i) => (
                <li key={i} className="break-words">
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-neutral-500">None listed</p>
          )}
        </div>
      </Card>
      <Card className="min-w-0 space-y-3 p-4">
        <h2 className="text-sm font-semibold">Base asset</h2>
        {run.asset ? <BaseAsset runId={run.id} asset={run.asset} /> : <p className="text-[13px] text-neutral-500">No base asset is recorded.</p>}
      </Card>
    </section>
  );
}

function BaseAsset({ runId, asset }: { runId: string; asset: NonNullable<DcoRunDetail["asset"]> }) {
  const preview = useAuthedImage(`/api/dco/runs/${runId}/asset`, asset.sha256);
  return (
    <>
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50">
        {preview.url ? (
          <img src={preview.url} alt="Base asset" className="h-full w-full object-contain" />
        ) : preview.failed ? (
          <span className="px-3 text-center text-xs text-neutral-500">Preview not available</span>
        ) : (
          <Spinner />
        )}
      </div>
      <dl className="grid gap-3">
        <Info label="File" value={asset.fileName} />
        <Info label="Size and type" value={`${fmtBytes(asset.bytes)}, ${asset.contentType}`} />
        <Info label="Uploaded by" value={`${asset.uploadedBy}, ${fmtDateTime(asset.uploadedAt)}`} />
        <Info label="Rights confirmed by" value={`${asset.rightsAttestedBy}, ${fmtDateTime(asset.rightsAttestedAt)}`} />
        <Info label="Checksum (first 12 characters)" value={asset.sha256.slice(0, 12)} />
      </dl>
    </>
  );
}

function VisualsSection({ run, canAct, acting, onPost }: { run: DcoRunDetail; canAct: boolean; acting: boolean; onPost: Post }) {
  const sorted = [...run.visuals].sort((a, b) => a.position - b.position);
  const ready = sorted.filter((v) => v.status === "ready").length;
  const segmentName = (key: string) => run.segments.find((s) => s.key === key)?.name ?? "All segments";
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Visual variants</h2>
        <span className="text-xs text-neutral-500">
          {ready} of {sorted.length} ready, {run.approvedVisuals} approved
        </span>
      </div>
      {run.safetyDiscarded > 0 && (
        <p className="text-[13px] text-neutral-600">
          {run.safetyDiscarded} {plural(run.safetyDiscarded, "result was", "results were")} discarded by the provider's safety filter and{" "}
          {plural(run.safetyDiscarded, "was", "were")} not shown.
        </p>
      )}
      {sorted.length === 0 ? (
        <Empty title="No visual variants yet">Visuals appear here as the image provider finishes each one.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((v) => (
            <VisualCard
              key={v.key}
              runId={run.id}
              runStatus={run.status}
              visual={v}
              segmentName={segmentName(v.segmentKey)}
              canAct={canAct}
              acting={acting}
              onPost={onPost}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function VisualCard({
  runId,
  runStatus,
  visual,
  segmentName,
  canAct,
  acting,
  onPost,
}: {
  runId: string;
  runStatus: DcoRunDetail["status"];
  visual: DcoVisualView;
  segmentName: string;
  canAct: boolean;
  acting: boolean;
  onPost: Post;
}) {
  const path = visual.hasImage ? `/api/dco/runs/${runId}/visuals/${visual.key}/image` : null;
  const image = useAuthedImage(path, visual.provenance?.outputSha256 ?? String(visual.bytes ?? 0));
  const reviewable = canAct && runStatus === "draft" && visual.status === "ready";
  const retryable = canAct && visual.status === "failed" && (runStatus === "draft" || runStatus === "failed" || runStatus === "queued" || runStatus === "running");

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-44 items-center justify-center bg-neutral-50">
        {image.url ? (
          <img src={image.url} alt={`${visual.label} for ${segmentName}`} className="max-h-72 w-full object-contain" />
        ) : isBusy(visual.status) ? (
          <span className="flex items-center gap-2 text-[13px] text-neutral-500">
            <Spinner />
            Generating
          </span>
        ) : visual.status === "failed" ? (
          <p className="px-4 py-6 text-center text-[13px] break-words text-red-700">{visual.error || "This variant could not be made."}</p>
        ) : visual.hasImage && !image.failed ? (
          <span className="flex items-center gap-2 text-[13px] text-neutral-500">
            <Spinner />
            Loading preview
          </span>
        ) : (
          <span className="px-4 py-6 text-center text-[13px] text-neutral-500">Preview not available</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="min-w-0">
          <div className="break-words text-[13px] font-medium">{visual.label}</div>
          <div className="mt-0.5 break-words text-xs text-neutral-500">
            {visual.kind === "format" ? "Format" : "Scene"}, {visual.format}, for {segmentName}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={ITEM_TONE[visual.status]}>{ITEM_LABEL[visual.status]}</Pill>
          {visual.status === "ready" && <StatusPill status={visual.reviewStatus} />}
        </div>
        {(reviewable || retryable) && (
          <div className="flex flex-wrap gap-2">
            {reviewable && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={acting || visual.reviewStatus === "approved"}
                  onClick={() => onPost(`/visuals/${visual.key}/review`, { decision: "approve" })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  disabled={acting || visual.reviewStatus === "rejected"}
                  onClick={() => onPost(`/visuals/${visual.key}/review`, { decision: "reject" })}
                >
                  Reject
                </Button>
              </>
            )}
            {retryable && (
              <Button size="sm" disabled={acting} onClick={() => onPost(`/visuals/${visual.key}/retry`)}>
                Retry
              </Button>
            )}
          </div>
        )}
        <Provenance p={visual.provenance} />
      </div>
    </Card>
  );
}

function Provenance({ p }: { p: DcoVisualView["provenance"] }) {
  if (!p) return <p className="text-xs text-neutral-500">Provenance appears once the variant is made.</p>;
  return (
    <details className="text-xs text-neutral-600">
      <summary className="cursor-pointer text-neutral-800 hover:text-neutral-900">Provenance</summary>
      <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-neutral-500">Model</dt>
        <dd className="break-all font-mono">{p.modelId}</dd>
        <dt className="text-neutral-500">Format</dt>
        <dd>{p.format}</dd>
        <dt className="text-neutral-500">Prompt</dt>
        <dd className="break-words">{p.prompt}</dd>
        <dt className="text-neutral-500">Negative prompt</dt>
        <dd className="break-words">{p.negativePrompt || "None"}</dd>
        <dt className="text-neutral-500">Seed</dt>
        <dd>{p.seed === null ? "Not returned by this model" : p.seed}</dd>
        <dt className="text-neutral-500">Request ID</dt>
        <dd className="break-all font-mono">{p.falRequestId}</dd>
        <dt className="text-neutral-500">Submitted</dt>
        <dd>{fmtDateTime(p.submittedAt)}</dd>
        <dt className="text-neutral-500">Completed</dt>
        <dd>{fmtDateTime(p.completedAt)}</dd>
        <dt className="text-neutral-500">Output checksum</dt>
        <dd className="font-mono">{p.outputSha256.slice(0, 12)}</dd>
        <dt className="text-neutral-500">Base asset checksum</dt>
        <dd className="font-mono">{p.inputSha256.slice(0, 12)}</dd>
      </dl>
    </details>
  );
}

function CopySection({ run, canAct, acting, onPost }: { run: DcoRunDetail; canAct: boolean; acting: boolean; onPost: Post }) {
  const reviewable = canAct && run.status === "draft";
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">Copy by segment</h2>
      {run.segments.map((seg) => (
        <SegmentCopy
          key={seg.key}
          segment={seg}
          copy={run.copy.filter((c) => c.segmentKey === seg.key).sort((a, b) => a.position - b.position)}
          runStatus={run.status}
          canAct={canAct}
          reviewable={reviewable}
          acting={acting}
          onPost={onPost}
        />
      ))}
    </section>
  );
}

function SegmentCopy({
  segment,
  copy,
  runStatus,
  canAct,
  reviewable,
  acting,
  onPost,
}: {
  segment: DcoSegmentView;
  copy: DcoCopyView[];
  runStatus: DcoRunDetail["status"];
  canAct: boolean;
  reviewable: boolean;
  acting: boolean;
  onPost: Post;
}) {
  const retryable = canAct && segment.status === "failed" && (runStatus === "draft" || runStatus === "failed" || runStatus === "queued" || runStatus === "running");
  return (
    <Card className="min-w-0 space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words text-sm font-medium">{segment.name}</div>
          {segment.note && <div className="break-words text-xs text-neutral-500">{segment.note}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={ITEM_TONE[segment.status]}>{ITEM_LABEL[segment.status]}</Pill>
          {retryable && (
            <Button size="sm" disabled={acting} onClick={() => onPost(`/segments/${segment.key}/retry`)}>
              Retry
            </Button>
          )}
        </div>
      </div>
      {segment.status === "failed" && <p className="break-words text-[13px] text-red-700">{segment.error || "The copy could not be written."}</p>}
      {isBusy(segment.status) ? (
        <span className="flex items-center gap-2 text-[13px] text-neutral-500">
          <Spinner />
          Writing copy
        </span>
      ) : copy.length === 0 ? (
        <p className="text-[13px] text-neutral-500">No copy options yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {copy.map((c, i) => (
            <CopyOption key={c.id} copy={c} number={i + 1} reviewable={reviewable} acting={acting} onPost={onPost} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CopyOption({ copy, number, reviewable, acting, onPost }: { copy: DcoCopyView; number: number; reviewable: boolean; acting: boolean; onPost: Post }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 bg-neutral-50/40 p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <span>Option {number}</span>
        <StatusPill status={copy.reviewStatus} />
      </div>
      <h3 className="break-words text-[15px] leading-snug font-semibold">{copy.headline}</h3>
      <Labelled label="Hook line" value={copy.hookLine} />
      <Labelled label="Caption" value={copy.caption} />
      <Labelled label="Call to action" value={copy.cta} />
      {copy.flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {copy.flags.map((f) => (
            <Tag key={f} tone={flagTone(f)}>
              {flagLabel(f)}
            </Tag>
          ))}
        </div>
      )}
      {reviewable && (
        <div className="mt-auto flex flex-wrap gap-2 border-t border-neutral-200 pt-3">
          <Button
            size="sm"
            variant="primary"
            disabled={acting || copy.reviewStatus === "approved"}
            onClick={() => onPost(`/copy/${copy.id}/review`, { decision: "approve" })}
          >
            Approve
          </Button>
          <Button size="sm" disabled={acting || copy.reviewStatus === "rejected"} onClick={() => onPost(`/copy/${copy.id}/review`, { decision: "reject" })}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

// Like a pill, but a long guard message may wrap instead of overflowing a narrow column
function Tag({ tone, children }: { tone: "amber" | "red"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[11px] font-medium break-words",
        tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700",
      )}
    >
      {children}
    </span>
  );
}

function Labelled({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="break-words text-[13px]">{value}</div>
    </div>
  );
}

function ReviewSection({
  run,
  canAct,
  acting,
  onPost,
  onExport,
}: {
  run: DcoRunDetail;
  canAct: boolean;
  acting: boolean;
  onPost: Post;
  onExport: () => void;
}) {
  const busy = run.visuals.some((v) => isBusy(v.status)) || run.segments.some((s) => isBusy(s.status));
  const blocker = run.approvedVisuals < 1 ? ERRORS.no_approved_visual : busy ? ERRORS.items_pending : null;
  const reviewable = canAct && run.status === "draft";
  return (
    <Card className="min-w-0 space-y-4 p-4">
      <h2 className="text-sm font-semibold">Job review</h2>
      {reviewable && (
        <div className="space-y-3">
          <p className="text-[13px] text-neutral-600">
            {blocker ?? "Approving freezes the job, and its approved visuals and copy go into the export pack."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={acting || blocker !== null} onClick={() => onPost("/review", { decision: "approve" })}>
              Approve job
            </Button>
            <Button disabled={acting} onClick={() => onPost("/review", { decision: "reject" })}>
              Reject job
            </Button>
          </div>
        </div>
      )}
      {run.status === "approved" && (
        <div className="space-y-3">
          <p className="text-[13px] text-neutral-600">
            Approved
            {run.reviewedAt ? ` ${fmtDateTime(run.reviewedAt)}` : ""}
            {run.reviewedBy ? ` by ${run.reviewedBy}` : ""}.
          </p>
          <p className="text-[13px] text-neutral-600">
            Pack contents: {run.approvedVisuals} approved {plural(run.approvedVisuals, "visual", "visuals")}, the approved copy as a CSV sheet, and a provenance
            CSV.
          </p>
          <Button variant="primary" disabled={acting || !run.exportable} onClick={onExport}>
            Export pack
          </Button>
        </div>
      )}
      {run.status === "rejected" && (
        <p className="text-[13px] text-neutral-600">This job was rejected{run.reviewedAt ? ` on ${fmtDateTime(run.reviewedAt)}` : ""}.</p>
      )}
      {run.status === "failed" && <p className="text-[13px] text-neutral-600">This job failed. Retry the items that need attention.</p>}
      {(run.status === "queued" || run.status === "running") && (
        <p className="text-[13px] text-neutral-600">Generation is still running. Review opens once it finishes.</p>
      )}
    </Card>
  );
}

function ActivitySection({ events }: { events: DcoRunDetail["events"] }) {
  return (
    <details className="rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Activity ({events.length})</summary>
      {events.length === 0 ? (
        <p className="border-t border-neutral-200 px-4 py-3 text-[13px] text-neutral-500">Nothing recorded yet.</p>
      ) : (
        <ol className="divide-y divide-neutral-100 border-t border-neutral-200">
          {events.map((e) => (
            <li key={e.id} className="grid gap-1 px-4 py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4">
              <span className="font-medium">{eventLabel(e.kind)}</span>
              <span className="tabular-nums text-neutral-500">{fmtDateTime(e.createdAt)}</span>
              <span className="break-all text-neutral-500">{e.actor}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
