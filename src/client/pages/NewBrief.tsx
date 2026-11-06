import { useMemo, useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, cx, Field, Input, Select, Textarea } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { categoryLabel, DEFAULT_BRIEF_PLATFORMS, LIVE_PLATFORM_NOTE, PLATFORM_LABELS } from "../lib/format";
import { useRouter } from "../lib/router";
import type { Role } from "../types";

const OBJECTIVES = [
  { id: "awareness", label: "Awareness", hint: "Reach the right people. Weights reach and audience fit highest." },
  { id: "engagement", label: "Engagement", hint: "Start conversations. Weights engagement and creative fit highest." },
  { id: "conversion", label: "Conversion", hint: "Drive sales. Weights proven outcome history highest." },
] as const;

const BUDGETS = [
  { id: "", label: "Not set" },
  { id: "under_100k", label: "Under ฿100k" },
  { id: "100k_500k", label: "฿100k to ฿500k" },
  { id: "500k_1m", label: "฿500k to ฿1M" },
  { id: "over_1m", label: "Over ฿1M" },
];

const FALLBACK_CATEGORIES = ["food_snacks", "beauty"];

const splitRefs = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const norm = (s: string) => s.replace(/^@/, "").toLowerCase();

export function NewBrief({ role }: { role: Role }) {
  const api = useApi();
  const { navigate } = useRouter();
  const categories = useResource<{ category: string; creators: number }[]>("/api/matrix/categories");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [objective, setObjective] = useState<string>("awareness");
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_BRIEF_PLATFORMS);
  const [audience, setAudience] = useState("");
  const [budgetBand, setBudgetBand] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [timeline, setTimeline] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = categories.data?.length ? categories.data : FALLBACK_CATEGORIES.map((c) => ({ category: c, creators: 0 }));
  const selectedCategory = category || options[0]?.category || "";

  // AC-MX-2: the include/exclude conflict is visible before the run starts; must-exclude wins
  const conflicts = useMemo(() => {
    const ex = new Set(splitRefs(exclude).map(norm));
    return [...new Set(splitRefs(include).map(norm))].filter((r) => ex.has(r));
  }, [include, exclude]);

  const togglePlatform = (p: string) => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { runId } = await api<{ runId: string }>("/api/matrix/runs", {
        method: "POST",
        body: {
          brand,
          productCategory: selectedCategory,
          objective,
          audience,
          budgetBand: budgetBand || undefined,
          platforms,
          mustInclude: splitRefs(include),
          mustExclude: splitRefs(exclude),
          timeline,
        },
      });
      navigate(`/matrix/runs/${runId}`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "invalid_brief"
          ? "Check the brief: a category, an objective and at least one platform are required."
          : e instanceof ApiError && e.code === "queue_unavailable"
            ? "Background work couldn't be scheduled just now. Try again in a minute."
            : "Couldn't start the run.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Creator Matrix", to: "/matrix" }, { label: "New shortlist" }]} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate("/matrix")}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting || platforms.length === 0 || !selectedCategory} onClick={() => void submit()}>
            {submitting ? "Starting" : "Run shortlist"}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-xl space-y-8 pb-16">
        <section className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Brief</h1>
            <p className="text-[13px] text-neutral-500">The system scores up to 40 matching creators and drafts a shortlist of 15 for your review.</p>
          </div>
          <Field label="Brand">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. a snack brand" />
          </Field>
          <Field label="Product category" hint={categories.data?.length === 0 ? "The roster is empty, so no creators will match yet." : undefined}>
            <Select value={selectedCategory} onChange={(e) => setCategory(e.target.value)}>
              {options.map((o) => (
                <option key={o.category} value={o.category}>
                  {categoryLabel(o.category)} ({o.creators} creators)
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-neutral-800">Objective</div>
            <div className="space-y-2">
              {OBJECTIVES.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setObjective(o.id)}
                  className={cx(
                    "flex w-full items-start justify-between rounded-lg border px-3.5 py-3 text-left",
                    objective === o.id ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:bg-neutral-50",
                  )}
                >
                  <div>
                    <div className="text-[13px] font-medium">{o.label}</div>
                    <div className="text-xs text-neutral-500">{o.hint}</div>
                  </div>
                  <span className={cx("mt-0.5 h-3.5 w-3.5 rounded-full border", objective === o.id ? "border-[5px] border-neutral-900" : "border-neutral-300")} />
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Audience and reach</h2>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-neutral-800">Platforms</div>
            <div className="flex gap-2">
              {Object.entries(PLATFORM_LABELS).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => togglePlatform(id)}
                  className={cx(
                    "h-8 rounded-md border px-3 text-[13px]",
                    platforms.includes(id) ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-700 hover:bg-neutral-50",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 text-xs text-neutral-500">{LIVE_PLATFORM_NOTE}</div>
          </div>
          <Field label="Target audience">
            <Textarea rows={3} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. Bangkok students and young professionals, 18 to 30, who snack at work" />
          </Field>
          <Field label="Budget band">
            <Select value={budgetBand} onChange={(e) => setBudgetBand(e.target.value)}>
              {BUDGETS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Constraints</h2>
          <Field label="Must include" hint="Handles or creator IDs, separated by spaces or commas.">
            <Input value={include} onChange={(e) => setInclude(e.target.value)} placeholder="@handle" />
          </Field>
          <Field label="Must exclude">
            <Input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="@handle" />
          </Field>
          {conflicts.length > 0 && (
            <Banner title="On both lists">
              {conflicts.map((c) => `@${c}`).join(", ")} {conflicts.length === 1 ? "is" : "are"} on the include and exclude lists. Exclude wins, so{" "}
              {conflicts.length === 1 ? "this creator" : "these creators"} won't be considered.
            </Banner>
          )}
          <Field label="Timeline">
            <Input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="e.g. posts live in December" />
          </Field>
        </section>
        {error && <Banner tone="red" title={error} />}
      </div>
    </Shell>
  );
}
