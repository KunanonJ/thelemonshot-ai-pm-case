import { useState } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, cx, Field, Input, Select, Textarea } from "../components/ui";
import { ApiError, useApi, useResource } from "../lib/api";
import { categoryLabel, fmtAgo, OBJECTIVE_LABELS, PLATFORM_LABELS } from "../lib/format";
import { useRouter } from "../lib/router";
import type { AttachableShortlist, ProposalTemplates, Role, ShortlistChoice } from "../types";

const OBJECTIVES = ["awareness", "engagement", "conversion"] as const;
const BUDGETS = [
  { id: "", label: "Not set" },
  { id: "under_100k", label: "Under ฿100k" },
  { id: "100k_500k", label: "฿100k to ฿500k" },
  { id: "500k_1m", label: "฿500k to ฿1M" },
  { id: "over_1m", label: "Over ฿1M" },
];
const SHORTLIST_MODES = [
  { id: "existing", label: "Attach a shortlist", hint: "Creator claims cite this Creator Matrix run." },
  { id: "new", label: "Start a new shortlist", hint: "A Matrix run starts with the proposal; the creator section waits for it." },
  { id: "none", label: "No shortlist for now", hint: "The creator section stays empty and names nobody until you attach one." },
] as const;

const splitList = (text: string) =>
  text
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function RadioCard({ selected, onClick, label, hint }: { selected: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("flex w-full items-start justify-between rounded-lg border px-3.5 py-3 text-left", selected ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:bg-neutral-50")}
    >
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-xs text-neutral-500">{hint}</div>
      </div>
      <span className={cx("mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border", selected ? "border-[5px] border-neutral-900" : "border-neutral-300")} />
    </button>
  );
}

export function NewProposal({ role }: { role: Role }) {
  const api = useApi();
  const { navigate } = useRouter();
  const templates = useResource<ProposalTemplates>("/api/proposals/templates");
  const shortlists = useResource<AttachableShortlist[]>("/api/proposals/shortlists");
  const categories = useResource<{ category: string; creators: number }[]>("/api/matrix/categories");

  const [template, setTemplate] = useState("standard");
  const [brand, setBrand] = useState("");
  const [product, setProduct] = useState("");
  const [objective, setObjective] = useState<string>("awareness");
  const [audience, setAudience] = useState("");
  const [budgetBand, setBudgetBand] = useState("");
  const [timeline, setTimeline] = useState("");
  const [retainerMonths, setRetainerMonths] = useState("6");
  const [toneNotes, setToneNotes] = useState("");
  const [mustAvoid, setMustAvoid] = useState("");
  const [language, setLanguage] = useState("en");
  const [mode, setMode] = useState<ShortlistChoice["mode"] | null>(null);
  const [matrixRunId, setMatrixRunId] = useState("");
  const [category, setCategory] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["instagram", "tiktok"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefer an approved shortlist when one exists; the planner can change it
  const available = shortlists.data ?? [];
  const suggested = available.find((s) => s.status === "approved") ?? available[0];
  const effectiveMode = mode ?? (suggested ? "existing" : "none");
  const effectiveRunId = matrixRunId || suggested?.id || "";
  const categoryOptions = categories.data?.length ? categories.data : [{ category: "food_snacks", creators: 0 }, { category: "beauty", creators: 0 }];
  const selectedCategory = category || categoryOptions[0]?.category || "";
  const isRetainer = template === "always_on";
  const months = Number(retainerMonths);

  const missing = [
    !brand.trim() && "brand",
    !product.trim() && "product",
    isRetainer && !(months >= 1 && months <= 24) && "retainer length (1 to 24 months)",
    effectiveMode === "existing" && !effectiveRunId && "a shortlist to attach",
    effectiveMode === "new" && platforms.length === 0 && "at least one platform",
  ].filter(Boolean) as string[];

  const togglePlatform = (p: string) => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  async function submit() {
    setSubmitting(true);
    setError(null);
    const shortlist: ShortlistChoice =
      effectiveMode === "existing" ? { mode: "existing", matrixRunId: effectiveRunId } : effectiveMode === "new" ? { mode: "new", productCategory: selectedCategory, platforms } : { mode: "none" };
    try {
      const { runId } = await api<{ runId: string }>("/api/proposals/runs", {
        method: "POST",
        body: {
          template,
          language,
          brand,
          product,
          objective,
          audience,
          budgetBand: budgetBand || undefined,
          timeline,
          retainerMonths: isRetainer ? months : undefined,
          toneNotes,
          mustAvoid: splitList(mustAvoid),
          shortlist,
        },
      });
      navigate(`/proposals/${runId}`);
    } catch (e) {
      const issues = e instanceof ApiError ? ((e.body as { issues?: { message: string }[] }).issues ?? []) : [];
      setError(
        e instanceof ApiError && e.code === "shortlist_not_attachable"
          ? "That shortlist can't be attached: it failed or was rejected."
          : issues.length
            ? issues.map((i) => i.message).join(". ")
            : "Couldn't start the proposal.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Shell
      role={role}
      title={<Crumbs items={[{ label: "Campaign Proposal", to: "/proposals" }, { label: "New proposal" }]} />}
      actions={
        <>
          <Button variant="ghost" onClick={() => navigate("/proposals")}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting || missing.length > 0} onClick={() => void submit()}>
            {submitting ? "Starting" : "Draft proposal"}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-xl space-y-8 pb-16">
        <section className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Template</h1>
            <p className="text-[13px] text-neutral-500">The template sets the sections, their order and what the brief must include.</p>
          </div>
          <div className="space-y-2">
            {(templates.data?.templates ?? []).map((t) => (
              <RadioCard key={t.id} selected={template === t.id} onClick={() => setTemplate(t.id)} label={t.name} hint={t.description} />
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Brief</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Brand">
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. a snack brand" />
            </Field>
            <Field label="Product">
              <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="e.g. seaweed chips, new flavour" />
            </Field>
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-neutral-800">Objective</div>
            <div className="flex gap-2">
              {OBJECTIVES.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setObjective(o)}
                  className={cx("h-8 rounded-md border px-3 text-[13px]", objective === o ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-700 hover:bg-neutral-50")}
                >
                  {OBJECTIVE_LABELS[o]}
                </button>
              ))}
            </div>
          </div>
          <Field label="Target audience">
            <Textarea rows={3} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. Bangkok office workers, 22 to 35, who snack between meetings" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Budget band">
              <Select value={budgetBand} onChange={(e) => setBudgetBand(e.target.value)}>
                {BUDGETS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
            {isRetainer ? (
              <Field label="Retainer length (months)">
                <Input type="number" min={1} max={24} value={retainerMonths} onChange={(e) => setRetainerMonths(e.target.value)} />
              </Field>
            ) : (
              <Field label="Timeline">
                <Input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="e.g. posts live in December" />
              </Field>
            )}
          </div>
          {isRetainer && (
            <Field label="Timeline">
              <Input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="e.g. starting January" />
            </Field>
          )}
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Creators</h2>
            <p className="text-[13px] text-neutral-500">The proposal only names creators from an attached shortlist, with their data cited.</p>
          </div>
          <div className="space-y-2">
            {SHORTLIST_MODES.map((m) => (
              <RadioCard key={m.id} selected={effectiveMode === m.id} onClick={() => setMode(m.id)} label={m.label} hint={m.hint} />
            ))}
          </div>
          {effectiveMode === "existing" &&
            (available.length ? (
              <Field label="Shortlist" hint="Approve the shortlist before approving the proposal.">
                <Select value={effectiveRunId} onChange={(e) => setMatrixRunId(e.target.value)}>
                  {available.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.brief?.brand || "Untitled brief"} · {s.brief ? categoryLabel(s.brief.productCategory) : ""} · {s.shortlisted ?? "–"} picks · {s.status} · {fmtAgo(s.createdAt)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Banner tone="neutral" title="No shortlists yet">
                Run a Creator Matrix shortlist first, or start a new one with this proposal.
              </Banner>
            ))}
          {effectiveMode === "new" && (
            <div className="space-y-3">
              <Field label="Product category">
                <Select value={selectedCategory} onChange={(e) => setCategory(e.target.value)}>
                  {categoryOptions.map((o) => (
                    <option key={o.category} value={o.category}>
                      {categoryLabel(o.category)} ({o.creators} creators)
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-neutral-800">Platforms</div>
                <div className="flex gap-2">
                  {Object.entries(PLATFORM_LABELS).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => togglePlatform(id)}
                      className={cx("h-8 rounded-md border px-3 text-[13px]", platforms.includes(id) ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-700 hover:bg-neutral-50")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Tone and guardrails</h2>
          <Field label="Tone notes">
            <Textarea rows={2} value={toneNotes} onChange={(e) => setToneNotes(e.target.value)} placeholder="e.g. playful, warm, never preachy about health" />
          </Field>
          <Field label="Topics to avoid" hint="Separated by commas. Drafts that mention one are flagged for review.">
            <Input value={mustAvoid} onChange={(e) => setMustAvoid(e.target.value)} placeholder="e.g. dieting, competitor names" />
          </Field>
          <Field label="Language of the draft">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="th">Thai</option>
            </Select>
          </Field>
        </section>
        {missing.length > 0 && <p className="text-xs text-neutral-500">Still needed: {missing.join(", ")}.</p>}
        {error && <Banner tone="red" title={error} />}
      </div>
    </Shell>
  );
}
