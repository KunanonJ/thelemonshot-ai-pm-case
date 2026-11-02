import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Empty, Td, Th } from "../components/ui";
import { useResource } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import type { RmnCampaignSummary, Role } from "../types";

// ⑥ Retail Media Network: the campaign list. The tracking is real; the demo store and its sales are simulated (HR-2).
export function RmnHome({ role }: { role: Role }) {
  const { navigate } = useRouter();
  const data = useResource<{ scope: string; campaigns: RmnCampaignSummary[] }>("/api/rmn/campaigns");
  const canCreate = role !== "viewer";
  const rows = data.data?.campaigns ?? [];

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Retail Media" }]} />}
      actions={
        canCreate && (
          <Button variant="primary" onClick={() => navigate("/rmn/new")}>
            New campaign
          </Button>
        )
      }
    >
      <p className="mb-3 text-[13px] text-neutral-500">
        Each creator gets tracked links into a demo store. Clicks and demo checkouts are attributed to creators under last-click and time-decay models.
      </p>
      {data.data && (
        <div className="mb-5">
          <Banner tone="neutral" title="Simulated commerce">
            {data.data.scope} Checkouts take no payment and collect no personal details.
          </Banner>
        </div>
      )}
      {data.data && rows.length === 0 ? (
        <Empty title="No retail media campaigns yet">
          {canCreate ? "Create a campaign to get tracked links for the creators you pick." : "Campaigns that planners create will appear here."}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Campaign</Th>
                <Th>Landing page</Th>
                <Th>Window</Th>
                <Th>Links</Th>
                <Th>Human clicks</Th>
                <Th>Bot clicks (excluded)</Th>
                <Th>Orders with a tracked click</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50/70">
                  <Td>
                    <Link to={`/rmn/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                  </Td>
                  <Td className="text-neutral-600">{r.landingLabel}</Td>
                  <Td className="tabular-nums text-neutral-600">{r.windowDays} days</Td>
                  <Td className="tabular-nums">{r.links}</Td>
                  <Td className="tabular-nums">{r.humanClicks}</Td>
                  <Td className="tabular-nums text-neutral-500">{r.botClicks}</Td>
                  <Td className="tabular-nums">{r.trackedOrders}</Td>
                  <Td className="text-neutral-600">{fmtDate(r.createdAt)}</Td>
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
