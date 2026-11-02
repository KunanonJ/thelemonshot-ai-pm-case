import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Empty, Pill, StatusPill, Td, Th } from "../components/ui";
import { useResource } from "../lib/api";
import { fmtAgo, fmtDate } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import type { CampaignSummary, Role } from "../types";

const STATUS_TONE = { active: "blue", closed: "green", archived: "neutral" } as const;

export function CampaignsHome({ role }: { role: Role }) {
  const { navigate } = useRouter();
  const data = useResource<{ scope: string; campaigns: CampaignSummary[] }>("/api/campaigns");
  const canRun = role !== "viewer";
  const rows = data.data?.campaigns ?? [];

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Optimization" }]} />}
      actions={
        canRun && (
          <Button variant="primary" onClick={() => navigate("/campaigns/new")}>
            New campaign
          </Button>
        )
      }
    >
      <p className="mb-3 text-[13px] text-neutral-500">
        Tracked posts are refreshed on a schedule and turned into digests: winners, losers and what to do next. Closing a campaign writes each creator's outcome back
        to the Creator Matrix.
      </p>
      {data.data && (
        <div className="mb-5">
          <Banner tone="neutral" title="Organic performance scope">
            {data.data.scope}
          </Banner>
        </div>
      )}
      {data.data && rows.length === 0 ? (
        <Empty title="No campaigns yet">{canRun ? "Register a campaign with the posts you want to track." : "Campaigns that planners register will appear here."}</Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Campaign</Th>
                <Th>Flight</Th>
                <Th>Posts</Th>
                <Th>Last refresh</Th>
                <Th>Latest digest</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50/70">
                  <Td>
                    <Link to={`/campaigns/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-neutral-500">{r.brand}</div>
                  </Td>
                  <Td className="text-neutral-600">
                    {fmtDate(r.startsAt)} to {fmtDate(r.endsAt)}
                  </Td>
                  <Td className="tabular-nums">
                    {r.posts}
                    {r.unavailable > 0 && (
                      <span className="ml-2">
                        <Pill tone="amber">{r.unavailable} unavailable</Pill>
                      </span>
                    )}
                  </Td>
                  <Td className="text-neutral-600">{fmtAgo(r.lastRefreshAt)}</Td>
                  <Td>{r.latestDigest ? <StatusPill status={r.latestDigest.status} /> : <span className="text-neutral-400">None yet</span>}</Td>
                  <Td>
                    <Pill tone={STATUS_TONE[r.status]}>{r.status[0]!.toUpperCase() + r.status.slice(1)}</Pill>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.error && <p className="mt-4 text-sm text-red-700">Couldn't load campaigns ({data.error}).</p>}
    </Shell>
  );
}
