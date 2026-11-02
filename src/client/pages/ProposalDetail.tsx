import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Drawer, Input, Pill, SampleDataPill, Select, Spinner, StatusPill, Td, Textarea, Th } from "../components/ui";
import { ApiError, useApi, useDownload, useResource } from "../lib/api";
import { fmtAgo, fmtCompact, fmtDateTime, fmtPct, KPI_BASIS_LABELS, OBJECTIVE_LABELS, ORIGIN_LABELS, PLATFORM_LABELS, sectionFlag } from "../lib/format";
import { Link } from "../lib/router";
import type { AttachableShortlist, Evidence, FieldSpec, LeafSpec, ProposalDetail as Proposal, ProposalSection, ProposalTemplates, ProposalVersion, Role, TrendRunSummary } from "../types";

type Content = Record<string, unknown>;
type Item = Record<string, string>;
type CreatorRow = { creatorId: string; role: string; why: string };

const isBusy = (s: ProposalSection) => s.status === "pending" || s.status === "generating";

const ERRORS: Record<string, string> = {
  sections_not_ready: "Some sections still need attention. Retry or edit them before approving.",
  shortlist_not_approved: "Approve the attached shortlist first, then approve the proposal.",
  section_busy: "That section is being drafted. Wait a moment and try again.",
  run_not_in_draft: "This proposal is no longer a draft.",
  creator_not_in_shortlist: "Only creators from the attached shortlist can be listed.",
  version_conflict: "Someone saved this section at the same time. Refresh and try again.",
  invalid_content: "Check the section: a field is too long.",
  export_requires_approval: "Approve the proposal before exporting.",
  shortlist_not_attachable: "That shortlist can't be attached: it failed or was rejected.",
  shortlist_already_attached: "A shortlist is already attached.",
  trend_not_approved: "Only an approved trend brief can be attached.",
  trend_already_attached: "That trend brief is already attached.",
  trend_not_found: "That trend brief no longer exists.",
  queue_unavailable: "Background work couldn't be scheduled just now. Nothing changed; try again in a minute.",
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "proposal";

export function ProposalDetail({ role, id, userId }: { role: Role; id: string; userId: string }) {
  const api = useApi();
  const downloadFile = useDownload();
  // Poll while anything is still being drafted
  const proposal = useResource<Proposal>(`/api/proposals/runs/${id}`, (p) => (p.status === "queued" || p.status === "running" || p.sections.some(isBusy) ? 2500 : null));
  const templates = useResource<ProposalTemplates>("/api/proposals/templates");
  const [preview, setPreview] = useState(0);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const p = proposal.data;
  const canEdit = role !== "viewer" && p?.status === "draft";

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setActing(true);
    setError(null);
    try {
      await fn();
      await proposal.reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? "That didn't go through. Refresh and try again.") : "That didn't go through. Refresh and try again.");
      return false;
    } finally {
      setActing(false);
    }
  }

  const post = (path: string, body?: unknown) => act(() => api(`/api/proposals/runs/${id}${path}`, { method: "POST", body: body ?? {} }));
  const exportAs = (format: "html" | "pptx") => act(() => downloadFile(`/api/proposals/runs/${id}/export.${format}`, `proposal-${slug(p?.brief.brand ?? "")}-${id.slice(0, 8)}.${format}`));

  const sections = p?.sections ?? [];
  const inFlight = p?.status === "queued" || p?.status === "running";
  const needAttention = sections.filter((s) => s.status === "failed");
  const blockers = p
    ? [
        ...(needAttention.length ? [`${needAttention.length} section${needAttention.length === 1 ? " needs" : "s need"} a retry or an edit`] : []),
        ...(sections.some(isBusy) ? ["sections are still being drafted"] : []),
        ...(p.shortlist && p.shortlist.status !== "approved" ? ["the attached shortlist isn't approved yet"] : []),
      ]
    : [];
  const titleOf = (key: unknown) => sections.find((s) => s.key === key)?.title ?? String(key);
  const historySection = sections.find((s) => s.key === historyFor) ?? null;

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Proposal", to: "/proposals" }, { label: p?.brief.brand || "Untitled brief" }]} />}
      actions={
        p && (
          <>
            {p.sampleData && <SampleDataPill />}
            <Button variant="ghost" onClick={() => setPreview((n) => n + 1)}>
              Preview
            </Button>
            {canEdit && (
              <>
                <Button disabled={acting} onClick={() => void post("/review", { decision: "reject" })}>
                  Reject
                </Button>
                <Button variant="primary" disabled={acting || blockers.length > 0} onClick={() => void post("/review", { decision: "approve" })}>
                  Approve proposal
                </Button>
              </>
            )}
            {p.status === "approved" && (
              <>
                <Button disabled={acting} onClick={() => void exportAs("html")}>
                  Export HTML
                </Button>
                <Button variant="primary" disabled={acting} onClick={() => void exportAs("pptx")}>
                  Export PPTX
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {!p ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">{proposal.error ? `Couldn't load this proposal (${proposal.error}).` : <Spinner />}</div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{p.brief.brand || "Untitled brief"}</h1>
              <StatusPill status={p.status} />
            </div>
            <div className="mt-1 text-[13px] text-neutral-500">
              {[p.template.name, OBJECTIVE_LABELS[p.brief.objective], p.brief.product].filter(Boolean).join(" · ")} · created {fmtAgo(p.createdAt)}
              {p.reviewedAt && ` · reviewed ${fmtDateTime(p.reviewedAt)}`}
            </div>
          </div>

          {inFlight && (
            <Card className="flex items-center gap-3 px-4 py-4 text-[13px]">
              <Spinner />
              <div>
                <div className="font-medium">
                  Drafting sections · {sections.filter((s) => s.status === "ready" || s.status === "failed").length} of {sections.length} done
                </div>
                <div className="text-neutral-500">Each section is drafted on its own, so finished ones appear while the rest are written.</div>
              </div>
            </Card>
          )}
          {error && <Banner tone="red" title={error} />}
          {canEdit && !inFlight && blockers.length > 0 && <Banner tone="neutral" title="Before approving">{blockers.join("; ")}.</Banner>}

          <ShortlistBar proposal={p} canEdit={canEdit} acting={acting} onAttach={(matrixRunId) => void post("/attach", { matrixRunId })} />

          <TrendBar proposal={p} canEdit={canEdit} acting={acting} onAttach={(trendRunId) => void post("/trends", { trendRunId })} />

          {sections.map((s) => (
            <SectionCard
              key={s.key}
              section={s}
              spec={templates.data?.fields[s.key] ?? []}
              proposal={p}
              canEdit={canEdit}
              acting={acting}
              maxAlternatives={templates.data?.maxAlternatives ?? 3}
              onSave={(content) => post(`/sections/${s.key}/edit`, { content })}
              onRegenerate={(alternatives, instruction) => post(`/sections/${s.key}/regenerate`, { alternatives, ...(instruction ? { instruction } : {}) })}
              onHistory={() => setHistoryFor(s.key)}
            />
          ))}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Assumptions</h2>
            <p className="mt-0.5 text-xs text-neutral-500">Built from the brief and the attached data; printed on the last page and slide of the export.</p>
            <ul className="mt-3 list-disc space-y-1.5 pl-4 text-[13px] text-neutral-700">
              {p.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </Card>

          {p.logs.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Activity</h2>
              <ul className="space-y-1 text-[13px] text-neutral-600">
                {p.logs.map((l) => (
                  <li key={l.id}>
                    <span className="text-neutral-400">{fmtDateTime(l.createdAt)}</span> · {l.actor === userId ? "You" : "A teammate"} {describeLog(l, titleOf)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {p && historySection && (
        <HistoryDrawer
          proposalId={id}
          section={historySection}
          spec={templates.data?.fields[historySection.key] ?? []}
          proposal={p}
          canEdit={canEdit && !isBusy(historySection)}
          onClose={() => setHistoryFor(null)}
          onUse={(versionId) => post(`/sections/${historySection.key}/use`, { versionId })}
        />
      )}
      <PreviewModal id={id} open={preview} onClose={() => setPreview(0)} />
    </Shell>
  );
}

function describeLog(l: Proposal["logs"][number], titleOf: (key: unknown) => string): string {
  const payload = l.payload;
  if (l.kind === "section") {
    if (payload.action === "edit") return `edited ${titleOf(payload.section)}`;
    if (payload.action === "use_version") return `switched ${titleOf(payload.section)} to version ${String(payload.version)}`;
    const n = Number(payload.alternatives ?? 1);
    return `asked for ${n === 1 ? "a new version" : `${n} alternatives`} of ${titleOf(payload.section)}${payload.instruction ? ` (“${String(payload.instruction)}”)` : ""}`;
  }
  if (l.kind === "attach") return `attached shortlist ${String(payload.matrixRunId).slice(0, 8)}`;
  if (l.kind === "decision") return `${payload.decision === "approve" ? "approved" : "rejected"} the proposal`;
  if (l.kind === "export") return `exported ${String(payload.format).toUpperCase()}`;
  return l.kind;
}

// ---------- shortlist ----------

function ShortlistBar({ proposal: p, canEdit, acting, onAttach }: { proposal: Proposal; canEdit: boolean; acting: boolean; onAttach: (matrixRunId: string) => void }) {
  const attachable = useResource<AttachableShortlist[]>(canEdit && !p.flags.shortlist ? "/api/proposals/shortlists" : null);
  const [choice, setChoice] = useState("");
  if (p.shortlist) {
    return (
      <Card className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
        <div>
          <span className="font-medium">Creators cite Creator Matrix run {p.shortlist.id.slice(0, 8)}</span>
          <span className="text-neutral-500">
            {" "}
            · {p.shortlist.picks.length} picks · {p.shortlist.status}
          </span>
          {p.status === "draft" && p.shortlist.status !== "approved" && <div className="text-xs text-amber-800">Approve this shortlist before approving the proposal.</div>}
        </div>
        <Link to={`/matrix/runs/${p.shortlist.id}`} className="text-xs text-neutral-600 hover:text-neutral-900 hover:underline">
          View shortlist
        </Link>
      </Card>
    );
  }
  const options = attachable.data ?? [];
  const selected = choice || (options.find((s) => s.status === "approved") ?? options[0])?.id || "";
  return (
    <Banner tone="neutral" title="No creator shortlist attached">
      The creator section stays empty and names nobody until a shortlist is attached.
      {canEdit && options.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <Select value={selected} onChange={(e) => setChoice(e.target.value)} className="max-w-md">
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.brief?.brand || "Untitled brief"} · {s.shortlisted ?? "–"} picks · {s.status} · {fmtAgo(s.createdAt)}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={acting || !selected} onClick={() => onAttach(selected)}>
            Attach and draft creators
          </Button>
        </div>
      )}
    </Banner>
  );
}

// ---------- trend briefs (AC-TM-2) ----------

// Approved ② trend briefs join the assumptions. Only approved briefs can be attached (HR-4).
function TrendBar({ proposal: p, canEdit, acting, onAttach }: { proposal: Proposal; canEdit: boolean; acting: boolean; onAttach: (trendRunId: string) => void }) {
  const briefs = useResource<{ scope: string; runs: TrendRunSummary[] }>(canEdit ? "/api/trends/runs" : null);
  const [choice, setChoice] = useState("");
  const attached = p.trends ?? [];
  const options = (briefs.data?.runs ?? []).filter((r) => r.status === "approved" && !attached.some((t) => t.runId === r.runId));
  const selected = options.some((o) => o.runId === choice) ? choice : (options[0]?.runId ?? "");
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Trend briefs</h2>
      <p className="mt-0.5 text-xs text-neutral-500">
        Approved trend briefs cited in the assumptions. Their figures describe the posts pulled for each brief, not the platforms as a whole.
      </p>
      {attached.length > 0 ? (
        <ul className="mt-3 space-y-1.5 text-[13px] text-neutral-700">
          {attached.map((t) => (
            <li key={t.runId}>
              <Link to={`/trends/${t.runId}`} className="font-medium hover:underline">
                Trend brief {t.runId.slice(0, 8)}
              </Link>
              <span className="text-neutral-500">
                {" "}
                · {t.terms.join(", ") || "no terms"} · {t.uniquePosts} unique posts · {t.themeCount} themes
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-neutral-500">None attached.</p>
      )}
      {canEdit && options.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Select value={selected} onChange={(e) => setChoice(e.target.value)} className="max-w-md">
            {options.map((o) => (
              <option key={o.runId} value={o.runId}>
                {o.labels.join(", ") || "Trend brief"} · {o.uniquePosts ?? 0} unique posts · {fmtAgo(o.createdAt)}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={acting || !selected} onClick={() => onAttach(selected)}>
            Attach trend brief
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------- sections ----------

function SectionCard(props: {
  section: ProposalSection;
  spec: FieldSpec[];
  proposal: Proposal;
  canEdit: boolean;
  acting: boolean;
  maxAlternatives: number;
  onSave: (content: Content) => Promise<boolean>;
  onRegenerate: (alternatives: number, instruction: string) => Promise<boolean>;
  onHistory: () => void;
}) {
  const { section: s, spec, proposal: p, canEdit, acting, maxAlternatives } = props;
  const [mode, setMode] = useState<"view" | "edit" | "regenerate">("view");
  const [count, setCount] = useState(1);
  const [instruction, setInstruction] = useState("");
  const busy = isBusy(s);
  const current = s.current;
  const emptyCreators = s.key === "creator_strategy" && !p.flags.shortlist;
  const actionable = canEdit && !busy && mode === "view" && !emptyCreators;

  async function regenerate(alternatives: number, steer: string) {
    if (await props.onRegenerate(alternatives, steer)) {
      setMode("view");
      setInstruction("");
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{s.title}</h2>
            {s.status === "failed" && <Pill tone="amber">Needs attention</Pill>}
            {s.status === "generating" && <Pill tone="blue">Drafting</Pill>}
            {s.status === "pending" && <Pill>Queued</Pill>}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            {current
              ? `Version ${current.version} · ${ORIGIN_LABELS[current.origin] ?? current.origin}${current.note ? ` · ${current.note}` : ""} · ${fmtAgo(current.createdAt)}`
              : "Not drafted yet"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {actionable && (
            <>
              <Button size="sm" variant="ghost" disabled={acting} onClick={() => setMode("edit")}>
                Edit
              </Button>
              {s.status === "failed" ? (
                <Button size="sm" variant="ghost" disabled={acting} onClick={() => void regenerate(1, "")}>
                  Retry
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={acting} onClick={() => setMode("regenerate")}>
                  Regenerate
                </Button>
              )}
            </>
          )}
          {s.versionCount > 1 && mode === "view" && (
            <Button size="sm" variant="ghost" onClick={props.onHistory}>
              History ({s.versionCount})
            </Button>
          )}
        </div>
      </div>

      {current && current.flags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {current.flags.map((f) => {
            const { label, tone } = sectionFlag(f);
            return (
              <Pill key={f} tone={tone}>
                {label}
              </Pill>
            );
          })}
        </div>
      )}
      {s.error && <div className={cx("px-4 pt-3 text-xs", s.status === "failed" ? "text-amber-800" : "text-neutral-500")}>{s.error}</div>}

      <div className="px-4 py-4">
        {busy && (
          <div className="mb-3 flex items-center gap-2 text-[13px] text-neutral-500">
            <Spinner /> {s.status === "pending" ? "Waiting its turn" : current ? "Drafting a new version; the current one stays until it's ready" : "Drafting"}
          </div>
        )}
        {mode === "edit" && current ? (
          <SectionEditor
            sectionKey={s.key}
            spec={spec}
            initial={current.content}
            proposal={p}
            acting={acting}
            onCancel={() => setMode("view")}
            onSave={async (content) => {
              if (await props.onSave(content)) setMode("view");
            }}
          />
        ) : current ? (
          <div className={cx(busy && "opacity-50")}>
            <SectionView sectionKey={s.key} spec={spec} content={current.content} proposal={p} />
          </div>
        ) : (
          !busy && <div className="text-[13px] text-neutral-500">Not drafted yet.</div>
        )}

        {mode === "regenerate" && (
          <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
            <div className="text-[13px] font-medium">Regenerate {s.title.toLowerCase()}</div>
            <div className="mt-2 flex items-center gap-2">
              {[1, maxAlternatives].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={cx("h-7 rounded-md border px-2.5 text-xs", count === n ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")}
                >
                  {n === 1 ? "One new version" : `${n} alternatives`}
                </button>
              ))}
            </div>
            <Input className="mt-2" value={instruction} maxLength={300} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional steer, e.g. more playful, lean on office snacking" />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-neutral-500">Other sections stay as they are; every result is kept in the history.</span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" disabled={acting} onClick={() => void regenerate(count, instruction.trim())}>
                  Regenerate
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// "TBC" marks a gap the planner has to fill (HR-3), so it stands out
function Text({ value, className }: { value: string; className?: string }) {
  if (!value.trim()) return <span className="text-neutral-400">–</span>;
  return (
    <span className={cx("whitespace-pre-wrap", className)}>
      {value.split(/(TBC)/).map((part, i) =>
        part === "TBC" ? (
          <mark key={i} className="rounded bg-amber-50 px-1 text-amber-800">
            TBC
          </mark>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function SectionView({ sectionKey, spec, content, proposal }: { sectionKey: string; spec: FieldSpec[]; content: Content; proposal: Proposal }) {
  return (
    <div className="space-y-4">
      {spec.map((f) => {
        if (f.kind === "line" || f.kind === "text") {
          const value = String(content[f.key] ?? "");
          const headline = sectionKey === "big_idea" && f.key === "title";
          if (sectionKey === "creator_strategy" && !proposal.flags.shortlist) return <Empty key={f.key} text={value} />;
          return (
            <div key={f.key}>
              {!headline && <div className="mb-0.5 text-xs text-neutral-500">{f.label}</div>}
              <div className={headline ? "text-lg font-semibold" : "text-[13px] leading-relaxed text-neutral-800"}>
                <Text value={value} />
              </div>
            </div>
          );
        }
        if (f.kind === "list") return <ListView key={f.key} sectionKey={sectionKey} spec={f.item} items={(content[f.key] as Item[] | undefined) ?? []} />;
        if (sectionKey === "creator_strategy" && !proposal.flags.shortlist) return null;
        return <CreatorsView key={f.key} rows={(content[f.key] as CreatorRow[] | undefined) ?? []} evidence={proposal.evidence} />;
      })}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-[13px] text-neutral-600">{text}</div>;
}

function ListView({ sectionKey, spec, items }: { sectionKey: string; spec: LeafSpec[]; items: Item[] }) {
  if (!items.length) return <div className="text-[13px] text-neutral-500">Nothing listed.</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <table className="w-full">
        <thead className="border-b border-neutral-200 bg-neutral-50/60">
          <tr>
            {spec.map((leaf) => (
              <Th key={leaf.key}>{leaf.label}</Th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {items.map((item, i) => (
            <tr key={i}>
              {spec.map((leaf, j) => (
                <Td key={leaf.key} className={cx(j === 0 && "font-medium")}>
                  <Text value={item[leaf.key] ?? ""} />
                  {sectionKey === "kpi_frame" && leaf.key === "target" && <div className="text-xs font-normal text-neutral-500">{KPI_BASIS_LABELS[item.basis ?? "tbc"]}</div>}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// FR-CP-2: every creator row shows the Matrix evidence it rests on
function EvidenceLine({ e }: { e: Evidence }) {
  const latest = Math.max(0, ...e.platforms.map((p) => p.fetchedAt));
  return (
    <div className="space-y-0.5 text-xs tabular-nums text-neutral-600">
      <div>Score {e.composite === null ? "–" : Math.round(e.composite)}</div>
      {e.platforms.map((p) => (
        <div key={p.platform}>
          <span className="text-neutral-400">{PLATFORM_LABELS[p.platform]?.slice(0, 2).toUpperCase()}</span> {fmtCompact(p.followers)}
          <span className="text-neutral-400"> · ER {fmtPct(p.engagementRate)}</span>
        </div>
      ))}
      {latest > 0 && <div className="text-neutral-400">data {fmtAgo(latest)}</div>}
    </div>
  );
}

function CreatorsView({ rows, evidence }: { rows: CreatorRow[]; evidence: Record<string, Evidence> }) {
  if (!rows.length) return <div className="text-[13px] text-neutral-500">No creators placed yet.</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <table className="w-full">
        <thead className="border-b border-neutral-200 bg-neutral-50/60">
          <tr>
            <Th>Creator</Th>
            <Th className="w-40">Role</Th>
            <Th>Why</Th>
            <Th className="w-40">Evidence</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => {
            const e = evidence[r.creatorId];
            return (
              <tr key={r.creatorId}>
                <Td>
                  <div className="font-medium">{e?.displayName ?? "Not in the shortlist"}</div>
                  <div className="text-xs text-neutral-500">
                    {e &&
                      Object.entries(e.handles)
                        .flatMap(([platform, h]) => (h ? [`${PLATFORM_LABELS[platform]?.slice(0, 2).toUpperCase()} @${h}`] : []))
                        .join(" · ")}
                  </div>
                </Td>
                <Td>
                  <Text value={r.role} />
                </Td>
                <Td className="text-neutral-700">
                  <Text value={r.why} />
                </Td>
                <Td>{e ? <EvidenceLine e={e} /> : <span className="text-xs text-neutral-400">No evidence</span>}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- structured editor (sections, not free-form HTML) ----------

function SectionEditor(props: {
  sectionKey: string;
  spec: FieldSpec[];
  initial: Content;
  proposal: Proposal;
  acting: boolean;
  onCancel: () => void;
  onSave: (content: Content) => Promise<void>;
}) {
  const { sectionKey, spec, proposal, acting } = props;
  const [draft, setDraft] = useState<Content>(() => structuredClone(props.initial));
  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="space-y-4">
      {spec.map((f) => {
        if (f.kind === "line" || f.kind === "text") {
          const value = String(draft[f.key] ?? "");
          return (
            <label key={f.key} className="block">
              <div className="mb-1 text-xs text-neutral-500">{f.label}</div>
              {f.readOnly ? (
                <div className="text-[13px] text-neutral-700">
                  {value} <span className="text-xs text-neutral-400">(from the brief)</span>
                </div>
              ) : f.kind === "line" ? (
                <Input value={value} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <Textarea rows={4} value={value} onChange={(e) => set(f.key, e.target.value)} />
              )}
            </label>
          );
        }
        if (f.kind === "list") {
          const items = (draft[f.key] as Item[] | undefined) ?? [];
          const update = (i: number, key: string, value: string) =>
            set(
              f.key,
              items.map((it, j) => (j !== i ? it : sectionKey === "kpi_frame" && key === "target" ? { ...it, target: value, basis: "planner" } : { ...it, [key]: value })),
            );
          const blank = sectionKey === "kpi_frame" ? { metric: "", target: "TBC", basis: "tbc", note: "" } : Object.fromEntries(f.item.map((leaf) => [leaf.key, ""]));
          return (
            <div key={f.key} className="space-y-2">
              <div className="text-xs text-neutral-500">{f.label}</div>
              {items.map((item, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-neutral-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-neutral-600">
                      {f.itemLabel} {i + 1}
                    </span>
                    <button className="text-xs text-neutral-500 hover:text-red-700" onClick={() => set(f.key, items.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                  {f.item.map((leaf) => (
                    <label key={leaf.key} className="block">
                      <div className="mb-1 text-xs text-neutral-500">{leaf.label}</div>
                      {leaf.kind === "line" ? (
                        <Input value={item[leaf.key] ?? ""} onChange={(e) => update(i, leaf.key, e.target.value)} />
                      ) : (
                        <Textarea rows={2} value={item[leaf.key] ?? ""} onChange={(e) => update(i, leaf.key, e.target.value)} />
                      )}
                    </label>
                  ))}
                </div>
              ))}
              {items.length < f.max && (
                <Button size="sm" onClick={() => set(f.key, [...items, blank])}>
                  Add {f.itemLabel.toLowerCase()}
                </Button>
              )}
            </div>
          );
        }
        const rows = (draft[f.key] as CreatorRow[] | undefined) ?? [];
        const unplaced = (proposal.shortlist?.picks ?? []).filter((id) => !rows.some((r) => r.creatorId === id) && proposal.evidence[id]);
        return (
          <div key={f.key} className="space-y-2">
            <div className="text-xs text-neutral-500">Creators (from the attached shortlist only)</div>
            {rows.map((r, i) => (
              <div key={r.creatorId} className="space-y-2 rounded-lg border border-neutral-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium">{proposal.evidence[r.creatorId]?.displayName ?? r.creatorId}</span>
                  <button className="text-xs text-neutral-500 hover:text-red-700" onClick={() => set(f.key, rows.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
                <Input value={r.role} placeholder="Role" onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
                <Textarea rows={2} value={r.why} placeholder="Why this creator" onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)))} />
              </div>
            ))}
            {unplaced.length > 0 && (
              <Select value="" onChange={(e) => e.target.value && set(f.key, [...rows, { creatorId: e.target.value, role: "", why: "" }])} className="max-w-xs">
                <option value="">Add a shortlisted creator…</option>
                {unplaced.map((id) => (
                  <option key={id} value={id}>
                    {proposal.evidence[id]!.displayName}
                  </option>
                ))}
              </Select>
            )}
          </div>
        );
      })}
      <div className="flex justify-end gap-2 border-t border-neutral-100 pt-3">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={acting} onClick={() => void props.onSave(draft)}>
          Save as new version
        </Button>
      </div>
    </div>
  );
}

// ---------- history (AC-CP-3) ----------

function HistoryDrawer(props: {
  proposalId: string;
  section: ProposalSection;
  spec: FieldSpec[];
  proposal: Proposal;
  canEdit: boolean;
  onClose: () => void;
  onUse: (versionId: string) => Promise<boolean>;
}) {
  const { section, proposal } = props;
  // The query changes with the section's state, so a new version or a switch reloads the list
  const versions = useResource<ProposalVersion[]>(`/api/proposals/runs/${props.proposalId}/sections/${section.key}/versions?n=${section.versionCount}&c=${section.current?.id ?? ""}`);
  return (
    <Drawer open title={`${section.title}: versions`} onClose={props.onClose} wide>
      {!versions.data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-neutral-500">Every draft, regeneration and edit is kept. Switching versions changes nothing else in the proposal.</p>
          {versions.data.map((v) => (
            <div key={v.id} className={cx("rounded-lg border p-3", v.isCurrent ? "border-neutral-900" : "border-neutral-200")}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs text-neutral-600">
                  <span className="font-medium text-neutral-900">Version {v.version}</span> · {ORIGIN_LABELS[v.origin] ?? v.origin}
                  {v.note ? ` · ${v.note}` : ""} · {fmtDateTime(v.createdAt)}
                </div>
                {v.isCurrent ? (
                  <Pill tone="green">Current</Pill>
                ) : (
                  props.canEdit && (
                    <Button size="sm" onClick={() => void props.onUse(v.id)}>
                      Use this version
                    </Button>
                  )
                )}
              </div>
              <SectionView sectionKey={section.key} spec={props.spec} content={v.content} proposal={proposal} />
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// ---------- preview ----------

function PreviewModal({ id, open, onClose }: { id: string; open: number; onClose: () => void }) {
  // `open` counts opens, so each one fetches a fresh render
  const html = useResource<string>(open ? `/api/proposals/runs/${id}/preview.html?v=${open}` : null);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex bg-neutral-900/30 p-6" onClick={onClose}>
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-12 items-center justify-between border-b border-neutral-200 px-4">
          <div className="text-sm font-semibold">Preview</div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {html.data ? (
          <iframe title="Proposal preview" sandbox="" srcDoc={html.data} className="w-full flex-1" />
        ) : (
          <div className="p-6 text-sm text-neutral-500">{html.error ? `Couldn't render the preview (${html.error}).` : <Spinner />}</div>
        )}
      </div>
    </div>
  );
}
