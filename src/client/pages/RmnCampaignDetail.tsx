import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Pill, SampleDataPill, Spinner, StatCard, Td, Th } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { RmnDashboard, RmnModel, Role } from "../types";

const MODEL_LABELS: Record<RmnModel, string> = { last_click: "Last-click", time_decay: "Time-decay" };

// Conversions can be fractional under time-decay, so they show to two places and drop trailing zeros
const fmtConv = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};
const fmtSignedConv = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? "0" : `${r > 0 ? "+" : "-"}${fmtConv(Math.abs(r))}`;
};
const fmtTHB = (n: number) => `THB ${Math.round(n).toLocaleString("en-GB")}`;
const fmtSignedTHB = (n: number) => {
  const r = Math.round(n);
  return r === 0 ? "THB 0" : `${r > 0 ? "+" : "-"}${fmtTHB(Math.abs(r))}`;
};
// HR-3: a rate with no clicks behind it shows as a gap, never as zero
const fmtRate = (n: number | null) => (n === null ? "No data" : `${(n * 100).toFixed(1)}%`);

const ERRORS: Record<string, string> = { not_found: "That link no longer exists." };

// ⑥ Campaign dashboard (FR-RM-4). Headline counts are bot-filtered. Simulated outcomes are labelled everywhere.
export function RmnCampaignDetail({ role, id }: { role: Role; id: string }) {
  const api = useApi();
  const data = useResource<RmnDashboard>(`/api/rmn/campaigns/${id}`);
  const [model, setModel] = useState<RmnModel>("last_click");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = data.data;
  const canEdit = role !== "viewer";

  async function setLinkDisabled(linkId: string, disabled: boolean) {
    setActing(true);
    setError(null);
    try {
      await api(`/api/rmn/campaigns/${id}/links/${linkId}`, { method: "PATCH", body: { disabled } });
      await data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? "That didn't go through. Refresh and try again.") : "That didn't go through.");
    } finally {
      setActing(false);
    }
  }

  if (!d) {
    return (
      <Shell role={role} title={<Crumbs items={[{ label: "Retail Media", to: "/rmn" }, { label: "Campaign" }]} />}>
        <div className="flex items-center gap-2 text-sm text-neutral-500">{data.error ? `Couldn't load this campaign (${data.error}).` : <Spinner />}</div>
      </Shell>
    );
  }

  const h = d.headline;
  const selected = d.models[model];
  // Conversions that move between creators when the model changes: half the total absolute shift
  const moved = d.creators.reduce((sum, c) => sum + Math.abs(c.timeDecay.conversions - c.lastClick.conversions), 0) / 2;

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Retail Media", to: "/rmn" }, { label: d.campaign.name }]} />}
      actions={d.sampleData && <SampleDataPill />}
    >
      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">{d.campaign.name}</h1>
            <Pill tone="blue">Demo store</Pill>
          </div>
          <p className="mt-1 text-[13px] text-neutral-500">
            Landing page: {d.campaign.landingLabel}. Attribution window: {d.campaign.windowDays} days.
          </p>
        </div>

        <Banner tone="neutral" title="Simulated commerce: RMN Demo Store">
          {d.scope} The store runs a simulated checkout with no real payment, and it collects no personal details.
        </Banner>

        {h.unattributedOrders > 0 && (
          <Banner tone="amber" title={`${h.unattributedOrders} unattributed ${h.unattributedOrders === 1 ? "order" : "orders"}`}>
            Every click from this campaign on {h.unattributedOrders === 1 ? "that order" : "those orders"} is older than the {d.campaign.windowDays}-day window, so no creator is
            credited (simulated revenue THB {Math.round(h.unattributedRevenue).toLocaleString("en-GB")}).
          </Banner>
        )}

        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Human clicks" value={h.humanClicks} hint={`${h.botClicks} bot clicks kept in the raw log, not counted`} />
          <StatCard label="Attributed orders" value={h.attributedOrders} hint="Simulated checkouts with a click inside the window" />
          <StatCard label="Conversion rate" value={fmtRate(h.conversionRate)} hint="Attributed orders per human click" />
          <StatCard label="Simulated revenue" value={fmtTHB(selected.revenue)} hint={`${MODEL_LABELS[model]}. Simulated, not real sales`} />
        </div>

        <p className="text-[13px] text-neutral-600">
          Demo funnel: {h.funnel.productViews} product {h.funnel.productViews === 1 ? "view" : "views"}, {h.funnel.cartAdds} added to cart,{" "}
          {h.funnel.checkouts} demo {h.funnel.checkouts === 1 ? "checkout" : "checkouts"} (simulated).
        </p>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Attribution models</h2>
              <p className="text-[13px] text-neutral-500">
                {model === "last_click"
                  ? "Last-click gives the whole sale to the latest human click inside the window."
                  : `Time-decay splits each sale across every human click inside the window. A click loses half its weight every ${d.halfLifeDays} days.`}
              </p>
            </div>
            <div className="inline-flex rounded-md border border-neutral-200 p-0.5">
              {(["last_click", "time_decay"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={model === m}
                  onClick={() => setModel(m)}
                  className={cx("h-7 rounded px-3 text-xs font-medium", model === m ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100")}
                >
                  {MODEL_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(["last_click", "time_decay"] as const).map((m) => (
              <Card key={m} className={cx("px-4 py-3", model === m ? "border-neutral-900" : "")}>
                <div className="flex items-center justify-between">
                  <div className="text-xs text-neutral-500">{MODEL_LABELS[m]}</div>
                  {model === m && <Pill tone="neutral">Shown below</Pill>}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-2xl font-semibold tracking-tight tabular-nums">{fmtConv(d.models[m].conversions)}</div>
                    <div className="text-xs text-neutral-500">conversions</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tracking-tight tabular-nums">{fmtTHB(d.models[m].revenue)}</div>
                    <div className="text-xs text-neutral-500">simulated revenue</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <p className="text-[13px] text-neutral-600">
            Time-decay moves <span className="font-medium tabular-nums">{fmtConv(moved)}</span> conversions between creators compared with last-click. Both models
            credit the same orders and the same revenue in total.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Creators ({MODEL_LABELS[model].toLowerCase()})</h2>
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-neutral-50/60">
                <tr>
                  <Th>Creator</Th>
                  <Th>Links</Th>
                  <Th>Human clicks</Th>
                  <Th>Bot clicks (excluded)</Th>
                  <Th>Conversions</Th>
                  <Th>Simulated revenue</Th>
                  <Th>Time-decay minus last-click</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {d.creators.map((c) => {
                  const diff = c.timeDecay.conversions - c.lastClick.conversions;
                  return (
                    <tr key={c.creatorId} className="hover:bg-neutral-50/70">
                      <Td className="font-medium">{c.name}</Td>
                      <Td className="tabular-nums">{c.links}</Td>
                      <Td className="tabular-nums">{c.humanClicks}</Td>
                      <Td className="tabular-nums text-neutral-500">{c.botClicks}</Td>
                      <Td className="tabular-nums">{fmtConv(model === "last_click" ? c.lastClick.conversions : c.timeDecay.conversions)}</Td>
                      <Td className="tabular-nums">{fmtTHB(model === "last_click" ? c.lastClick.revenue : c.timeDecay.revenue)}</Td>
                      <Td className={cx("tabular-nums", Math.abs(diff) > 0.005 ? "text-neutral-900" : "text-neutral-400")}>
                        {fmtSignedConv(diff)} conversions
                        <div className="text-xs text-neutral-500">{fmtSignedTHB(c.timeDecay.revenue - c.lastClick.revenue)} revenue</div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.creators.length === 0 && <p className="text-[13px] text-neutral-500">No creators are linked to this campaign.</p>}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Tracked links</h2>
          <p className="text-[13px] text-neutral-500">
            A turned-off link sends the visitor to a neutral page, and the attempt is logged. The redirect reads a cached copy in Cloudflare KV, which is eventually
            consistent, so a change can take up to about a minute to reach every location.
          </p>
          {error && <Banner tone="red" title={error} />}
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-neutral-50/60">
                <tr>
                  <Th>Creator</Th>
                  <Th>Variant</Th>
                  <Th>Link</Th>
                  <Th>Status</Th>
                  <Th>Human clicks</Th>
                  <Th>Bot clicks (excluded)</Th>
                  {canEdit && <Th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {d.links.map((l) => (
                  <tr key={l.linkId} className="hover:bg-neutral-50/70">
                    <Td className="font-medium">{l.creatorName}</Td>
                    <Td className="text-neutral-600">{l.variant ?? "Main link"}</Td>
                    <Td className="max-w-xs break-all font-mono text-xs text-neutral-700">{l.url}</Td>
                    <Td>
                      {l.disabled ? (
                        <Pill tone="red" title={l.statusChangedAt ? `Turned off ${fmtDateTime(l.statusChangedAt)}` : undefined}>
                          Turned off
                        </Pill>
                      ) : (
                        <Pill tone="green">Active</Pill>
                      )}
                    </Td>
                    <Td className="tabular-nums">{l.humanClicks}</Td>
                    <Td className="tabular-nums text-neutral-500">{l.botClicks}</Td>
                    {canEdit && (
                      <Td>
                        <Button size="sm" disabled={acting} onClick={() => void setLinkDisabled(l.linkId, !l.disabled)}>
                          {l.disabled ? "Turn on" : "Turn off"}
                        </Button>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Raw click log</h2>
            <p className="text-[13px] text-neutral-500">
              The latest {d.rawLog.length} entries. Bot traffic stays in this log and is left out of every headline count, model total and conversion rate.
              Turned-off attempts are listed here too.
            </p>
          </div>
          {d.rawLog.length === 0 ? (
            <p className="text-[13px] text-neutral-500">No clicks yet. Share a link to start the log.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <table className="w-full">
                <thead className="border-b border-neutral-200 bg-neutral-50/60">
                  <tr>
                    <Th>Time</Th>
                    <Th>Creator</Th>
                    <Th>Variant</Th>
                    <Th>Traffic</Th>
                    <Th>Result</Th>
                    <Th>Referrer</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {d.rawLog.map((k, i) => (
                    <tr key={`${k.clickedAt}-${i}`} className="hover:bg-neutral-50/70">
                      <Td className="whitespace-nowrap text-neutral-600">{fmtDateTime(k.clickedAt)}</Td>
                      <Td>{k.creatorName}</Td>
                      <Td className="text-neutral-600">{k.variant ?? "Main link"}</Td>
                      <Td>
                        {k.uaClass === "human" ? (
                          <Pill tone="blue">Human</Pill>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Pill tone="amber">Bot</Pill>
                            <span className="text-xs text-neutral-500">{k.botReason}</span>
                          </span>
                        )}
                      </Td>
                      <Td>{k.result === "redirected" ? "Sent to the store" : <Pill tone="red">Link turned off</Pill>}</Td>
                      <Td className="text-neutral-600">{k.referrerHost ?? "Direct"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
