import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Field, Input, Pill, SampleDataPill, Select, Textarea } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { categoryLabel } from "../lib/format";
import { useRouter } from "../lib/router";
import type { RmnCatalog, RmnCreated, Role } from "../types";

type RosterCreator = { id: string; displayName: string; active: boolean; isSample: boolean; categories: string[] };

const MAX_LINKS = 60;
const ERRORS: Record<string, string> = {
  unknown_landing: "Pick a landing page from the list.",
  unknown_creator: "Some selected creators are no longer active. Reselect them and try again.",
  too_many_links: `A campaign can have at most ${MAX_LINKS} links. Pick fewer creators or variants.`,
};

// ⑥ Create a campaign: a window, a landing page in the demo store, the linked creators and optional per-post variants
export function NewRmnCampaign({ role }: { role: Role }) {
  const api = useApi();
  const { navigate } = useRouter();
  const catalog = useResource<RmnCatalog>("/api/rmn/catalog");
  const roster = useResource<RosterCreator[]>("/api/creators");
  const [name, setName] = useState("");
  const [windowDays, setWindowDays] = useState("7");
  const [landing, setLanding] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [variantText, setVariantText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creators = (roster.data ?? []).filter((c) => c.active);
  const variants = variantText
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  const days = Number(windowDays);
  const windowOk = Number.isInteger(days) && days >= 1 && days <= 30;
  const linkCount = picked.length * (1 + new Set(variants.map((v) => v.toLowerCase())).size);
  const valid = name.trim() !== "" && windowOk && landing !== "" && picked.length > 0 && linkCount <= MAX_LINKS;

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function submit() {
    const [landingKind, landingId] = landing.split(":") as ["product" | "category", string];
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<RmnCreated>("/api/rmn/campaigns", {
        method: "POST",
        body: { name: name.trim(), windowDays: days, landingKind, landingId, creatorIds: picked, variants },
      });
      navigate(`/rmn/${created.id}`);
    } catch (e) {
      const issues = e instanceof ApiError ? (e.body as { issues?: string[] }).issues : undefined;
      setError(issues?.length ? issues.join(". ") : e instanceof ApiError ? (ERRORS[e.code] ?? "Couldn't create the campaign.") : "Couldn't create the campaign.");
      setSubmitting(false);
    }
  }

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Retail Media", to: "/rmn" }, { label: "New campaign" }]} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate("/rmn")}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? "Creating" : "Create campaign"}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-3xl space-y-8 pb-16">
        <section className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Campaign</h1>
            <p className="text-[13px] text-neutral-500">
              Shoppers who click a creator's link land on the chosen demo page. Checkouts there are simulated, and no payment is taken.
            </p>
          </div>
          <Banner tone="neutral" title="Simulated commerce">
            The tracking and attribution engine is real. The storefront and its sales are simulated.
          </Banner>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Seaweed chips test" />
            </Field>
            <Field label="Attribution window (days)" hint="A click earns credit for a checkout only if it is no older than this. Allowed: 1 to 30.">
              <Input type="number" min={1} max={30} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
            </Field>
          </div>
          <Field label="Landing page" hint="A demo product or a demo category.">
            <Select value={landing} onChange={(e) => setLanding(e.target.value)}>
              <option value="">Choose a page</option>
              <optgroup label="Demo products">
                {(catalog.data?.products ?? []).map((p) => (
                  <option key={p.id} value={`product:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Demo categories">
                {(catalog.data?.categories ?? []).map((cat) => (
                  <option key={cat.id} value={`category:${cat.id}`}>
                    {cat.label}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Creators</h2>
              <p className="text-[13px] text-neutral-500">Each selected creator gets a unique tracked link. {picked.length} selected.</p>
            </div>
            {creators.some((c) => c.isSample) && <SampleDataPill />}
          </div>
          {roster.data && creators.length === 0 ? (
            <Card className="px-4 py-6 text-center text-[13px] text-neutral-500">No active creators in the roster yet.</Card>
          ) : (
            <Card className="max-h-80 divide-y divide-neutral-100 overflow-y-auto">
              {creators.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-50">
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className="flex-1 text-[13px] text-neutral-900">{c.displayName}</span>
                  <span className="text-xs text-neutral-500">{c.categories.map((k) => categoryLabel(k)).join(", ")}</span>
                  {c.isSample && <Pill tone="amber">Sample</Pill>}
                </label>
              ))}
            </Card>
          )}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Per-post variants (optional)</h2>
            <p className="text-[13px] text-neutral-500">
              One name per line, such as "Post 1". Each selected creator gets one extra link per name, in addition to their main link. {linkCount} links in total.
            </p>
          </div>
          <Textarea rows={4} value={variantText} onChange={(e) => setVariantText(e.target.value)} placeholder={"Post 1\nPost 2"} />
        </section>

        {error && <Banner tone="red" title={error} />}
      </div>
    </Shell>
  );
}
