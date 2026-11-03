import { useMemo, useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, cx, Drawer, Empty, Field, Input, Pill, SampleDataPill, StatusPill, Td, Th } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { categoryLabel, fmtAgo, fmtCompact, fmtPct, PLATFORM_LABELS } from "../lib/format";
import type { Creator, Role } from "../types";

type DeadLetter = { id: string; kind: string; reason: string; creatorName: string | null; platform: string | null; createdAt: number };
type DiscoveryDefaults = Record<string, { label: string; instagram: string[]; tiktok: string[] }>;

const STALE_MS = 72 * 3_600_000;

type DiscoveryResult = { started: number; platforms: { platform: "instagram" | "tiktok"; status: "started" | "failed"; reason?: string }[] };

// Fixed reasons from the API (finding 22); the raw Apify text stays on the operator's side
const DISCOVERY_REASONS: Record<string, string> = {
  not_configured: "Apify isn't set up yet",
  refused: "Apify refused the request, so check the token",
  limited: "Apify's usage limit was reached",
  timeout: "Apify didn't answer in time",
  unavailable: "Apify was unavailable",
  not_queued: "the run started but couldn't be scheduled for polling, so it was stopped",
};

function describeFailed(platforms: DiscoveryResult["platforms"]): string {
  const failed = platforms.filter((p) => p.status === "failed");
  return failed.map((p) => `${p.platform === "instagram" ? "Instagram" : "TikTok"}: ${DISCOVERY_REASONS[p.reason ?? ""] ?? "couldn't start"}.`).join(" ");
}

export function Creators({ role }: { role: Role }) {
  const api = useApi();
  const isAdmin = role === "admin";
  // While enrichment is still running for someone, keep the list fresh
  const creators = useResource<Creator[]>("/api/creators", (rows) => (rows.some((c) => c.enrichmentStatus === "pending") ? 8000 : null));
  const deadLetters = useResource<DeadLetter[]>(role === "viewer" ? null : "/api/creators/dead-letters");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  const all = creators.data ?? [];
  const categories = useMemo(() => [...new Set(all.flatMap((c) => c.categories))].sort(), [all]);
  const visible = all.filter(
    (c) =>
      (filter === "all" || c.categories.includes(filter)) &&
      (!query || [c.displayName, c.instagram, c.tiktok, c.youtube].some((v) => v?.toLowerCase().includes(query.toLowerCase()))),
  );

  async function patch(id: string, body: Record<string, unknown>) {
    await api(`/api/creators/${id}`, { method: "PATCH", body });
    await creators.reload();
  }
  async function refresh(id: string) {
    await api(`/api/creators/${id}/refresh`, { method: "POST" });
    await creators.reload();
  }

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creators" }]} />}
      actions={
        <>
          <SampleDataPill />
          {isAdmin && <Button onClick={() => setDiscovering(true)}>Find creators</Button>}
          {isAdmin && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add creator
            </Button>
          )}
        </>
      }
    >
      <p className="mb-5 text-[13px] text-neutral-500">
        The shared creator spine. Stats come from snapshots refreshed in the background every 72 hours; products never call the platforms directly.
      </p>

      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {["all", ...categories].map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={cx("h-7 rounded-md px-2.5 text-[13px]", filter === c ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100")}
            >
              {c === "all" ? `All (${all.length})` : `${categoryLabel(c)} (${all.filter((x) => x.categories.includes(c)).length})`}
            </button>
          ))}
        </div>
        <Input className="max-w-56" placeholder="Search name or handle" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {all.length === 0 && creators.data ? (
        <Empty title="The roster is empty">
          {isAdmin ? "Use Find creators to discover public creators by category hashtags, or add one by handle." : "An admin can add creators."}
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full">
            <thead className="border-b border-neutral-200 bg-neutral-50/60">
              <tr>
                <Th>Creator</Th>
                <Th>Category</Th>
                <Th>Followers</Th>
                <Th>Engagement</Th>
                <Th>Refreshed</Th>
                <Th>Status</Th>
                {isAdmin && <Th className="text-right">Actions</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {visible.map((c) => {
                const last = Math.max(0, ...c.snapshots.map((s) => s.fetched_at));
                return (
                  <tr key={c.id} className={cx(!c.active && "opacity-50")}>
                    <Td>
                      <div className="font-medium">{c.displayName}</div>
                      <div className="text-xs text-neutral-500">
                        {[c.instagram && `IG @${c.instagram}`, c.tiktok && `TT @${c.tiktok}`, c.youtube && `YT @${c.youtube}`].filter(Boolean).join(" · ")}
                      </div>
                    </Td>
                    <Td className="text-neutral-600">{c.categories.map(categoryLabel).join(", ")}</Td>
                    <Td className="tabular-nums">
                      {c.snapshots.length === 0 && <span className="text-neutral-400">no data</span>}
                      {c.snapshots.map((s) => (
                        <div key={s.platform} className="text-xs">
                          <span className="text-neutral-500">{PLATFORM_LABELS[s.platform]?.slice(0, 2).toUpperCase()}</span> {fmtCompact(s.followers)}
                        </div>
                      ))}
                    </Td>
                    <Td className="tabular-nums">
                      {c.snapshots.map((s) => (
                        <div key={s.platform} className="text-xs">
                          {fmtPct(s.engagement_rate)}
                        </div>
                      ))}
                    </Td>
                    <Td className="text-xs">
                      {last ? (
                        <span className={Date.now() - last > STALE_MS ? "text-amber-700" : "text-neutral-600"}>{fmtAgo(last)}</span>
                      ) : (
                        <span className="text-neutral-400">never</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <StatusPill status={c.enrichmentStatus} />
                        {!c.active && <Pill>Inactive</Pill>}
                      </div>
                    </Td>
                    {isAdmin && (
                      <Td className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" onClick={() => void refresh(c.id)}>
                          Refresh
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void patch(c.id, { active: !c.active })}>
                          {c.active ? "Deactivate" : "Activate"}
                        </Button>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(deadLetters.data?.length ?? 0) > 0 && (
        <Card className="mt-6 p-4">
          <h2 className="text-[13px] font-semibold">Dead letters ({deadLetters.data!.length})</h2>
          <p className="text-xs text-neutral-500">Items that failed processing. Nothing disappears silently.</p>
          <ul className="mt-3 divide-y divide-neutral-100 text-[13px]">
            {deadLetters.data!.map((d) => (
              <li key={d.id} className="flex justify-between gap-4 py-2">
                <span>
                  <span className="font-medium">{d.creatorName ?? "Run"}</span> <span className="text-neutral-600">· {d.reason}</span>
                </span>
                <span className="whitespace-nowrap text-xs text-neutral-400">{fmtAgo(d.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AddCreatorDrawer open={adding} onClose={() => setAdding(false)} onDone={() => void creators.reload()} categories={categories} />
      <DiscoveryDrawer open={discovering} onClose={() => setDiscovering(false)} />
    </Shell>
  );
}

function AddCreatorDrawer({ open, onClose, onDone, categories }: { open: boolean; onClose: () => void; onDone: () => void; categories: string[] }) {
  const api = useApi();
  const [form, setForm] = useState({ displayName: "", category: categories[0] ?? "food_snacks", instagram: "", tiktok: "", youtube: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/creators", {
        method: "POST",
        body: { displayName: form.displayName, categories: [form.category], instagram: form.instagram, tiktok: form.tiktok, youtube: form.youtube },
      });
      onDone();
      onClose();
      setForm({ ...form, displayName: "", instagram: "", tiktok: "", youtube: "" });
    } catch (e) {
      setError(e instanceof ApiError && e.code === "handle_already_in_roster" ? "One of these handles is already in the roster." : "Give a category and at least one handle.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={open} title="Add creator" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] text-neutral-500">Enrichment starts right away. The creator becomes scoreable when the first snapshot lands, usually within two minutes.</p>
        <Field label="Display name">
          <Input value={form.displayName} onChange={set("displayName")} placeholder="Optional" />
        </Field>
        <Field label="Category" hint="Use an existing category so briefs can find this creator.">
          <Input value={form.category} onChange={set("category")} list="known-categories" />
          <datalist id="known-categories">
            {["food_snacks", "beauty", ...categories].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Instagram handle">
          <Input value={form.instagram} onChange={set("instagram")} placeholder="@handle" />
        </Field>
        <Field label="TikTok handle">
          <Input value={form.tiktok} onChange={set("tiktok")} placeholder="@handle" />
        </Field>
        <Field label="YouTube handle">
          <Input value={form.youtube} onChange={set("youtube")} placeholder="@handle" />
        </Field>
        {error && <Banner tone="red" title={error} />}
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Adding" : "Add and enrich"}
        </Button>
      </div>
    </Drawer>
  );
}

function DiscoveryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const defaults = useResource<DiscoveryDefaults>(open ? "/api/admin/discovery/defaults" : null);
  const [category, setCategory] = useState("food_snacks");
  const [ig, setIg] = useState<string | null>(null);
  const [tt, setTt] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const preset = defaults.data?.[category];
  const igValue = ig ?? preset?.instagram.join(", ") ?? "";
  const ttValue = tt ?? preset?.tiktok.join(", ") ?? "";
  const list = (s: string) =>
    s
      .split(/[,\n]+/)
      .map((x) => x.trim().replace(/^#/, ""))
      .filter(Boolean);

  async function start() {
    setStatus("Starting");
    try {
      const r = await api<DiscoveryResult>("/api/admin/discovery", { method: "POST", body: { category, instagramHashtags: list(igValue), tiktokHashtags: list(ttValue) } });
      const failed = describeFailed(r.platforms);
      setStatus(
        failed
          ? `Started ${r.started} of ${r.platforms.length}. ${failed}`
          : "Started. New creators appear in a few minutes and are enriched automatically.",
      );
    } catch (e) {
      const failed = e instanceof ApiError ? describeFailed((e.body as Partial<DiscoveryResult>).platforms ?? []) : "";
      setStatus(failed ? `Couldn't start. ${failed}` : "Couldn't start.");
    }
  }

  return (
    <Drawer
      open={open}
      title="Find creators"
      onClose={() => {
        onClose();
        setStatus(null);
      }}
    >
      <div className="space-y-4">
        <p className="text-[13px] text-neutral-500">
          Pulls recent public posts under each hashtag with Apify and adds up to 35 new creators per platform as sample data. You curate the list afterwards.
        </p>
        <Field label="Category">
          <div className="flex gap-2">
            {Object.entries(defaults.data ?? { food_snacks: { label: "Food & snacks" }, beauty: { label: "Beauty" } }).map(([id, d]) => (
              <button
                key={id}
                onClick={() => {
                  setCategory(id);
                  setIg(null);
                  setTt(null);
                }}
                className={cx("h-8 rounded-md border px-3 text-[13px]", category === id ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200")}
              >
                {(d as { label: string }).label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Instagram hashtags">
          <Input value={igValue} onChange={(e) => setIg(e.target.value)} />
        </Field>
        <Field label="TikTok hashtags">
          <Input value={ttValue} onChange={(e) => setTt(e.target.value)} />
        </Field>
        {status && <Banner tone="neutral" title={status} />}
        <Button variant="primary" onClick={() => void start()}>
          Start discovery
        </Button>
      </div>
    </Drawer>
  );
}
