import type { ReactNode } from "react";
import { useResource } from "../lib/api";
import { UserMenu } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import { cx } from "./ui";

type NavItem = { label: string; to?: string; soon?: string; adminOnly?: boolean };
type Degraded = { source: "apify" | "youtube_api"; since: number; reason: string };

const SOURCE_LABELS: Record<Degraded["source"], string> = { apify: "Instagram and TikTok", youtube_api: "YouTube" };

// Products in PRD build order; later ones show their phase until they ship
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Products",
    items: [
      { label: "Creator Matrix", to: "/matrix" },
      { label: "Campaign Proposal", to: "/proposals" },
      { label: "Campaign Optimization", to: "/campaigns" },
      { label: "Trend Monitoring", to: "/trends" },
      { label: "Creative Variants", to: "/dco" },
      { label: "Retail Media", to: "/rmn" },
    ],
  },
  { section: "Data", items: [{ label: "Creators", to: "/creators" }] },
  { section: "Admin", items: [{ label: "System", to: "/system", adminOnly: true }] },
];

export function Shell({ role, title, actions, children }: { role: string; title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { path } = useRouter();
  // NFR-5: admins see the weekly cost alert on every page; it never blocks anything
  const cost = useResource<{ over: boolean; totalThb: number; thresholdThb: number }>(role === "admin" ? "/api/admin/cost-alert" : null);
  // Finding 18: a source failing for everyone is said once, on every page, not left to show as stale rows
  const status = useResource<{ degraded: Degraded[] }>("/api/status");
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col border-r border-neutral-200 bg-neutral-50/70">
        <div className="flex h-14 items-center gap-2 px-4">
          <span className="h-4 w-4 rounded-full bg-[#f4e04d] ring-1 ring-black/10" />
          <span className="text-sm font-semibold">Lemon Shot</span>
          <span className="text-xs text-neutral-400">AI Suite</span>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-2">
          {NAV.map(({ section, items }) => {
            const visible = items.filter((i) => !i.adminOnly || role === "admin");
            if (!visible.length) return null;
            return (
              <div key={section}>
                <div className="px-2 pb-1 text-[11px] font-medium text-neutral-400">{section}</div>
                {visible.map((item) =>
                  item.to ? (
                    <Link
                      key={item.label}
                      to={item.to}
                      className={cx(
                        "flex h-7 items-center rounded-md px-2 text-[13px]",
                        path.startsWith(item.to) ? "bg-neutral-200/70 font-medium text-neutral-900" : "text-neutral-600 hover:bg-neutral-100",
                      )}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <div key={item.label} className="flex h-7 items-center justify-between px-2 text-[13px] text-neutral-400">
                      {item.label}
                      <span className="text-[10px]">{item.soon}</span>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-3">
          <UserMenu />
          <span className="text-xs text-neutral-500">{role}</span>
        </div>
      </aside>
      <main className="pl-56">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-neutral-200 bg-white/90 px-6 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">{title}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
        {status.data?.degraded.map((d) => (
          <div key={d.source} className="border-b border-amber-200 bg-amber-50/70 px-6 py-2 text-[13px] text-amber-900">
            {SOURCE_LABELS[d.source]} data isn't refreshing right now ({d.reason}, since {fmtDateTime(d.since)}). Scores and digests use the last data that arrived, and
            each row shows its age.
          </div>
        ))}
        {cost.data?.over && (
          <div className="border-b border-amber-200 bg-amber-50/70 px-6 py-2 text-[13px] text-amber-900">
            External costs this week are ฿{cost.data.totalThb.toLocaleString("en")}, over the ฿{cost.data.thresholdThb.toLocaleString("en")} threshold. Nothing has been stopped.{" "}
            <Link to="/system" className="underline">
              See System
            </Link>
          </div>
        )}
        <div className="mx-auto max-w-[1240px] px-6 py-6">{children}</div>
      </main>
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <>
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-neutral-300">/</span>}
          {item.to ? (
            <Link to={item.to} className="text-neutral-500 hover:text-neutral-900">
              {item.label}
            </Link>
          ) : (
            <span className="truncate font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </>
  );
}
