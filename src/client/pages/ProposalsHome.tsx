import { Crumbs, Shell } from "../components/Shell";
import { Button, Empty, Pill, StatusPill, Td, Th } from "../components/ui";
import { useResource } from "../lib/api";
import { fmtAgo, OBJECTIVE_LABELS, TEMPLATE_LABELS } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import type { ProposalSummary, Role } from "../types";

export function ProposalsHome({ role }: { role: Role }) {
  const { navigate } = useRouter();
  // Keep refreshing while any proposal is still being drafted
  const runs = useResource<ProposalSummary[]>("/api/proposals/runs", (rows) => (rows.some((r) => r.status === "queued" || r.status === "running") ? 3000 : null));
  const canRun = role !== "viewer";

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Proposal" }]} />}
      actions={
        canRun && (
          <Button variant="primary" onClick={() => navigate("/proposals/new")}>
            New proposal
          </Button>
        )
      }
    >
      <p className="mb-5 text-[13px] text-neutral-500">
        Strategy and proposal drafts from a brief, section by section. Creator claims cite a Creator Matrix shortlist; every proposal is a draft until a person approves it.
      </p>
      {runs.data && runs.data.length === 0 ? (
        <Empty title="No proposals yet">
          {canRun ? "Start with a brief and, if you have one, an approved creator shortlist." : "Proposals that planners create will appear here."}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Proposal</Th>
                <Th>Template</Th>
                <Th>Objective</Th>
                <Th>Creators</Th>
                <Th>Sections</Th>
                <Th>Status</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(runs.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50/70">
                  <Td>
                    <Link to={`/proposals/${r.id}`} className="font-medium hover:underline">
                      {r.brief?.brand || "Untitled brief"}
                    </Link>
                    <div className="text-xs text-neutral-500">{r.brief?.product}</div>
                  </Td>
                  <Td className="text-neutral-600">{TEMPLATE_LABELS[r.flags.template] ?? r.flags.template}</Td>
                  <Td>{r.brief ? OBJECTIVE_LABELS[r.brief.objective] : "–"}</Td>
                  <Td>{r.flags.shortlist ? <span className="text-neutral-700">Shortlist attached</span> : <span className="text-neutral-400">None</span>}</Td>
                  <Td className="tabular-nums">
                    {r.progress.ready}/{r.progress.total}
                    {r.progress.failed > 0 && (
                      <span className="ml-2">
                        <Pill tone="amber">{r.progress.failed} need attention</Pill>
                      </span>
                    )}
                  </Td>
                  <Td>
                    <StatusPill status={r.status} />
                  </Td>
                  <Td className="text-right text-neutral-500">{fmtAgo(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.error && <p className="mt-4 text-sm text-red-700">Couldn't load proposals ({runs.error}).</p>}
    </Shell>
  );
}
