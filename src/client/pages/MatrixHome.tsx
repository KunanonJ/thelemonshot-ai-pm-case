import { Crumbs, Shell } from "../components/Shell";
import { Button, Empty, SampleDataPill, StatusPill, Td, Th } from "../components/ui";
import { useResource } from "../lib/api";
import { categoryLabel, fmtAgo, OBJECTIVE_LABELS, PLATFORM_LABELS } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import type { Role, RunSummary } from "../types";

export function MatrixHome({ role }: { role: Role }) {
  const { navigate } = useRouter();
  // Keep refreshing while any run is still being scored
  const runs = useResource<RunSummary[]>("/api/matrix/runs", (rows) => (rows.some((r) => r.status === "queued" || r.status === "running") ? 3000 : null));
  const canRun = role !== "viewer";

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creator Matrix" }]} />}
      actions={
        <>
          <SampleDataPill />
          {canRun && (
            <Button variant="primary" onClick={() => navigate("/matrix/new")}>
              New shortlist
            </Button>
          )}
        </>
      }
    >
      <p className="mb-5 text-[13px] text-neutral-500">Scored, explained creator shortlists from a brief. Every shortlist is a draft until a person approves it.</p>
      {runs.data && runs.data.length === 0 ? (
        <Empty title="No shortlists yet">
          {canRun ? "Start with a brief: pick a category, an objective and the platforms you need." : "Shortlists that planners create will appear here."}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Brief</Th>
                <Th>Objective</Th>
                <Th>Platforms</Th>
                <Th>Shortlisted</Th>
                <Th>Status</Th>
                <Th className="text-right">Created</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {(runs.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50/70">
                  <Td>
                    <Link to={`/matrix/runs/${r.id}`} className="font-medium hover:underline">
                      {r.brief?.brand || "Untitled brief"}
                    </Link>
                    <div className="text-xs text-neutral-500">{r.brief ? categoryLabel(r.brief.productCategory) : ""}</div>
                  </Td>
                  <Td>{r.brief ? OBJECTIVE_LABELS[r.brief.objective] : "–"}</Td>
                  <Td className="text-neutral-600">{r.brief?.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</Td>
                  <Td>{r.flags.shortlisted ?? "–"}</Td>
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
      {runs.error && <p className="mt-4 text-sm text-red-700">Couldn't load shortlists ({runs.error}).</p>}
    </Shell>
  );
}
