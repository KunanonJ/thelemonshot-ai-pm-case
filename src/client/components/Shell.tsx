import { useEffect, useState, type ReactNode } from "react";
import { LIMIT_EVENT, useResource, type LimitCode } from "../lib/api";
import { UserMenu } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import { Link, useRouter } from "../lib/router";
import { cx } from "./ui";

type NavItem = { label: string; to?: string; soon?: string; adminOnly?: boolean };
type Degraded = { source: "apify" | "youtube_api"; since: number; reason: string };

const SOURCE_LABELS: Record<Degraded["source"], string> = { apify: "Instagram and TikTok", youtube_api: "YouTube" };

const LIMIT_TEXT: Record<LimitCode, string> = {
  daily_limit_reached:
    "You've used today's allowance of new runs on this demo. It resets at midnight UTC (07:00 in Bangkok). Everything you've made can still be opened and reviewed.",
  weekly_budget_reached:
    "This demo has reached its spending limit for the week, so new runs are paused. Everything already made can still be opened and reviewed.",
};

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
  // NFR-5: admins see the weekly cost alert on every page; it pauses members' new paid runs, never an admin's
  const cost = useResource<{ over: boolean; totalThb: number; thresholdThb: number }>(role === "admin" ? "/api/admin/cost-alert" : null);
  // Finding 18: a source failing for everyone is said once, on every page, not left to show as stale rows
  const status = useResource<{ degraded: Degraded[] }>("/api/status");
  const [limit, setLimit] = useState<LimitCode | null>(null);
  useEffect(() => {
    const onLimit = (e: Event) => setLimit((e as CustomEvent<LimitCode>).detail);
    window.addEventListener(LIMIT_EVENT, onLimit);
    return () => window.removeEventListener(LIMIT_EVENT, onLimit);
  }, []);
  // Below the md breakpoint the sidebar becomes a drawer behind a menu button; it closes on navigation or Escape
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const banner = "border-b border-amber-200 bg-amber-50/70 px-4 py-2 text-[13px] text-amber-900 md:px-6";
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-neutral-200 bg-neutral-50/70 md:flex">
        <div className="flex h-14 items-center px-4">
          <Brand />
        </div>
        <NavList role={role} path={path} />
        <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-3">
          <UserMenu />
          <span className="text-xs text-neutral-500">{role}</span>
        </div>
      </aside>
      <div className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-neutral-200 bg-white px-4 md:hidden">
        <Brand />
        <div className="flex items-center gap-3">
          <UserMenu />
          <button
            type="button"
            className="-mr-1 flex h-9 w-9 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 h-full w-full bg-black/30" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80%] flex-col bg-white shadow-xl">
            <div className="flex h-12 items-center justify-between px-4">
              <Brand />
              <button type="button" className="-mr-1 flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>
            <NavList role={role} path={path} />
            <div className="border-t border-neutral-200 px-4 py-3 text-xs text-neutral-500">Signed in as {role}</div>
          </aside>
        </div>
      )}
      <main className="md:pl-56">
        <header className="sticky top-12 z-10 flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-neutral-200 bg-white/90 px-4 py-2 backdrop-blur md:top-0 md:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">{title}</div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
        {status.data?.degraded.map((d) => (
          <div key={d.source} className={banner}>
            {SOURCE_LABELS[d.source]} data isn't refreshing right now ({d.reason}, since {fmtDateTime(d.since)}). Scores and digests use the last data that arrived, and
            each row shows its age.
          </div>
        ))}
        {cost.data?.over && (
          <div className={banner}>
            External costs this week are ฿{cost.data.totalThb.toLocaleString("en")}, over the ฿{cost.data.thresholdThb.toLocaleString("en")} threshold. Members' new paid runs are paused; yours aren't.{" "}
            <Link to="/system" className="underline">
              See System
            </Link>
          </div>
        )}
        {limit && <div className={banner}>{LIMIT_TEXT[limit]}</div>}
        <div className="mx-auto max-w-[1240px] px-4 py-4 md:px-6 md:py-6">{children}</div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2">
      <span className="h-4 w-4 rounded-full bg-[#f4e04d] ring-1 ring-black/10" />
      <span className="text-sm font-semibold">Lemon Shot</span>
      <span className="text-xs text-neutral-400">AI Suite</span>
    </span>
  );
}

function NavList({ role, path }: { role: string; path: string }) {
  return (
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
                    "flex h-9 items-center rounded-md px-2 text-[13px] md:h-7",
                    path.startsWith(item.to) ? "bg-neutral-200/70 font-medium text-neutral-900" : "text-neutral-600 hover:bg-neutral-100",
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <div key={item.label} className="flex h-9 items-center justify-between px-2 text-[13px] text-neutral-400 md:h-7">
                  {item.label}
                  <span className="text-[10px]">{item.soon}</span>
                </div>
              ),
            )}
          </div>
        );
      })}
    </nav>
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
