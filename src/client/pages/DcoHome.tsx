import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Empty, Pill, Spinner, StatusPill } from "../components/ui";
import { useResource } from "../lib/api";
import { fmtAgo } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import type { DcoAllowlist, DcoRunSummary, Role } from "../types";

// Product law from PRD-01 section 8.5, shown wherever a variant job is created or reviewed
export const DCO_RULE = "DCO varies backgrounds, layouts, formats, and copy. It never synthesises, alters, or imitates any creator's face or voice.";

export function GoverningRule() {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
      <div className="text-xs font-medium text-neutral-500">Governing rule</div>
      <p className="mt-0.5 text-[13px] text-neutral-800">{DCO_RULE}</p>
    </div>
  );
}

// File sizes in plain units for the file picker and the asset panel
export function fmtBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function DcoHome({ role }: { role: Role }) {
  const { navigate } = useRouter();
  const allowlist = useResource<DcoAllowlist>("/api/dco/allowlist");
  // Keep refreshing while any job is still generating
  const runs = useResource<DcoRunSummary[]>("/api/dco/runs", (rows) => (rows.some((r) => r.status === "queued" || r.status === "running") ? 3000 : null));
  const canRun = role !== "viewer";

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creative Variants" }]} />}
      actions={
        canRun && (
          <Button variant="primary" onClick={() => navigate("/dco/new")}>
            New variant job
          </Button>
        )
      }
    >
      <div className="space-y-6">
        <p className="max-w-2xl text-[13px] text-neutral-500">
          Turn one brand or product image you have the rights to adapt into copy and visual variants for each segment. Every variant is a draft until a person approves it, and each keeps a record of how it was made.
        </p>
        <GoverningRule />
        <AllowlistPanel data={allowlist.data} error={allowlist.error} />
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Variant jobs</h2>
          <RunTable runs={runs.data} error={runs.error} canRun={canRun} />
        </section>
      </div>
    </Shell>
  );
}

function AllowlistPanel({ data, error }: { data: DcoAllowlist | null; error: string | null }) {
  if (!data) {
    return (
      <Card className="p-4 text-[13px] text-neutral-500">
        {error ? (
          `Couldn't load the model allowlist (${error}).`
        ) : (
          <span className="flex items-center gap-2">
            <Spinner />
            Loading the model allowlist
          </span>
        )}
      </Card>
    );
  }
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Image models on the allowlist</h2>
        <span className="text-xs text-neutral-500">Changing this list is a code change, never a setting</span>
      </div>
      <ul className="divide-y divide-neutral-100">
        {data.models.map((m) => (
          <li key={m.id} className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-4">
            <div className="min-w-0">
              <div className="break-all font-mono text-xs text-neutral-900">{m.id}</div>
              <div className="mt-0.5 text-[13px] text-neutral-600">{m.description}</div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 md:justify-end">
              <Pill tone="blue">{m.role === "layout" ? "Layout" : "Scene"}</Pill>
              <span>Safety flag: {m.providerSafetyField}</span>
              <span>Checked {m.verifiedOn}</span>
              <a href={m.docs} target="_blank" rel="noreferrer" className="text-neutral-700 underline underline-offset-2 hover:text-neutral-900">
                Provider docs
              </a>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-neutral-600">
        <span className="font-medium text-neutral-800">Excluded by design:</span> {data.blockedFamilies.join(", ")}
      </p>
      {data.audit.ok ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-800">
          <Pill tone="green">Audit passed</Pill>
          No person or face synthesis model is reachable from this configuration
          <span className="text-xs text-neutral-500">({data.audit.checked} models checked)</span>
        </p>
      ) : (
        <Banner tone="red" title="The model allowlist fails the audit">
          <ul className="list-disc space-y-1 pl-5">
            {data.audit.violations.map((v) => (
              <li key={`${v.id}:${v.reason}`}>
                <span className="font-mono text-xs">{v.id}</span>: {v.reason}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </Card>
  );
}

const RUN_COLUMNS = "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

function RunTable({ runs, error, canRun }: { runs: DcoRunSummary[] | null; error: string | null; canRun: boolean }) {
  if (!runs) {
    return error ? <p className="text-sm text-red-700">Couldn't load variant jobs ({error}).</p> : <Spinner />;
  }
  if (runs.length === 0) {
    return (
      <Empty title="No variant jobs yet">
        {canRun ? "Start with a brand or product image you have the rights to adapt." : "Variant jobs that a planner creates will appear here."}
      </Empty>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <div className={`hidden bg-neutral-50/60 px-4 py-2 text-xs text-neutral-500 lg:grid lg:gap-3 ${RUN_COLUMNS}`}>
        <div>Job</div>
        <div>Status</div>
        <div>Visuals ready</div>
        <div>Approved visuals</div>
        <div className="lg:text-right">Created</div>
      </div>
      <ul className="divide-y divide-neutral-100">
        {runs.map((r) => (
          <li key={r.id}>
            <Link to={`/dco/${r.id}`} className={`grid gap-2 px-4 py-3 hover:bg-neutral-50/70 lg:items-center lg:gap-3 ${RUN_COLUMNS}`}>
              <div className="min-w-0">
                <div className="break-words text-[13px] font-medium">{r.brief?.brand || "Untitled brief"}</div>
                <div className="break-words text-xs text-neutral-500">{r.brief?.product}</div>
              </div>
              <div>
                <StatusPill status={r.status} />
              </div>
              <div className="text-[13px] tabular-nums">
                <span className="text-neutral-500 lg:hidden">Visuals ready: </span>
                {r.progress.visualsReady}/{r.progress.visualsTotal}
              </div>
              <div className="text-[13px] tabular-nums">
                <span className="text-neutral-500 lg:hidden">Approved visuals: </span>
                {r.progress.approvedVisuals}
              </div>
              <div className="text-[13px] text-neutral-500 lg:text-right">{fmtAgo(r.createdAt)}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
