import { useState, type FormEvent } from "react";
import { Crumbs, Shell } from "../components/Shell";
import { Banner, Button, Card, Field, Input, Select, Textarea } from "../components/ui";
import { useAuthBridge } from "../lib/auth";
import { useRouter } from "../lib/router";
import type { Role } from "../types";
import { fmtBytes, GoverningRule } from "./DcoHome";

const MAX_SEGMENTS = 4;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const TOO_LARGE = "The file is larger than 8 MB. Choose a smaller file.";
const BAD_TYPE = "Use a PNG, JPEG or WebP image.";
const FALLBACK = "That didn't go through. Try again.";

type SegmentRow = { id: string; name: string; note: string };
type Issue = { path: string; message: string };

const newSegment = (): SegmentRow => ({ id: crypto.randomUUID(), name: "", note: "" });

// Plain words for each code the create route can return
const ERRORS: Record<string, string> = {
  invalid_brief: "Check the highlighted fields.",
  rights_attestation_required: "Tick the box to confirm you have the rights to adapt this asset.",
  missing_asset: "Choose a base asset file.",
  file_too_large: TOO_LARGE,
  unsupported_file_type: BAD_TYPE,
  forbidden: "Your role can't create variant jobs.",
};

function fileProblem(file: File | null): string | null {
  if (!file) return null;
  if (!ACCEPTED_TYPES.includes(file.type)) return BAD_TYPE;
  if (file.size > MAX_ASSET_BYTES) return TOO_LARGE;
  return null;
}

// Issue paths look like "brand" or "segments.1.name"; each one lands on the field it belongs to
function mapIssues(issues: Issue[]): { fields: Record<string, string>; other: string | null } {
  const fields: Record<string, string> = {};
  let other: string | null = null;
  for (const issue of issues) {
    const parts = issue.path.split(".");
    const head = parts[0] ?? "";
    const key = head === "segments" && parts[1] !== undefined ? `segments.${parts[1]}` : head;
    if (key === "") other = other ?? issue.message;
    else fields[key] = fields[key] ?? issue.message;
  }
  return { fields, other };
}

export function NewDco({ role }: { role: Role }) {
  const { navigate } = useRouter();
  const { getToken } = useAuthBridge();
  const [brand, setBrand] = useState("");
  const [product, setProduct] = useState("");
  const [offer, setOffer] = useState("");
  const [segments, setSegments] = useState<SegmentRow[]>(() => [newSegment()]);
  const [brandVoice, setBrandVoice] = useState("");
  const [claims, setClaims] = useState("");
  const [copyPerSegment, setCopyPerSegment] = useState(3);
  const [file, setFile] = useState<File | null>(null);
  const [attested, setAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const assetError = fileProblem(file);
  const complete =
    brand.trim() !== "" && product.trim() !== "" && segments.every((s) => s.name.trim() !== "") && file !== null && assetError === null && attested;
  const canSubmit = complete && !submitting;

  const updateSegment = (id: string, patch: Partial<SegmentRow>) => setSegments((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addSegment = () => setSegments((rows) => (rows.length >= MAX_SEGMENTS ? rows : [...rows, newSegment()]));
  const removeSegment = (id: string) => setSegments((rows) => (rows.length <= 1 ? rows : rows.filter((r) => r.id !== id)));

  const fieldError = (key: string) => (fields[key] ? <p className="mt-1 break-words text-xs text-red-700">{fields[key]}</p> : null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setFormError(null);
    setFields({});
    const brief = {
      brand: brand.trim(),
      product: product.trim(),
      ...(offer.trim() ? { offer: offer.trim() } : {}),
      segments: segments.map((s) => ({ name: s.name.trim(), ...(s.note.trim() ? { note: s.note.trim() } : {}) })),
      ...(brandVoice.trim() ? { brandVoice: brandVoice.trim() } : {}),
      prohibitedClaims: claims
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c !== ""),
      copyPerSegment,
    };
    const body = new FormData();
    body.append("brief", JSON.stringify(brief));
    body.append("asset", file);
    body.append("attest", "true");
    try {
      const token = await getToken();
      const res = await fetch("/api/dco/runs", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
      const data = (await res.json().catch(() => ({}))) as { runId?: string; error?: string; issues?: Issue[] };
      if (res.status === 201 && data.runId) {
        navigate(`/dco/${data.runId}`);
        return;
      }
      const mapped = mapIssues(data.issues ?? []);
      setFields(mapped.fields);
      setFormError(mapped.other ?? ERRORS[data.error ?? ""] ?? (res.status === 413 ? TOO_LARGE : res.status === 415 ? BAD_TYPE : FALLBACK));
    } catch {
      setFormError("The job couldn't be sent. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell role={role} title={<Crumbs items={[{ label: "Creative Variants", to: "/dco" }, { label: "New variant job" }]} />}>
      <form onSubmit={submit} className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">New variant job</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Upload one base asset and describe the brand. The job writes copy for each segment and makes visual variants of the asset. Nothing is final until a person approves it.
          </p>
        </div>
        <GoverningRule />
        {formError && <Banner tone="red" title="This job wasn't created.">{formError}</Banner>}

        <Card className="space-y-5 p-5">
          <h2 className="text-sm font-semibold">Brief</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <Field label="Brand">
                <Input required value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Brand name" />
              </Field>
              {fieldError("brand")}
            </div>
            <div className="min-w-0">
              <Field label="Product">
                <Input required value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Product name" />
              </Field>
              {fieldError("product")}
            </div>
          </div>

          <div className="min-w-0">
            <Field label="Offer (optional)" hint="Only enter offers you can stand behind. Left blank, the copy writes TBC where an offer belongs.">
              <Input value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="Leave blank if there is no offer" />
            </Field>
            {fieldError("offer")}
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-[13px] font-medium text-neutral-800">Segments</div>
              <div className="mt-0.5 text-xs text-neutral-500">Between one and four audience segments. Copy is written for each one.</div>
            </div>
            {segments.map((s, i) => (
              <div key={s.id} className="grid gap-3 rounded-md border border-neutral-200 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <Field label={`Segment ${i + 1} name`}>
                    <Input required value={s.name} onChange={(e) => updateSegment(s.id, { name: e.target.value })} />
                  </Field>
                  {fieldError(`segments.${i}`)}
                </div>
                <Field label="Note (optional)">
                  <Input value={s.note} onChange={(e) => updateSegment(s.id, { note: e.target.value })} />
                </Field>
                <Button type="button" size="sm" variant="ghost" disabled={segments.length === 1} onClick={() => removeSegment(s.id)}>
                  Remove
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" size="sm" disabled={segments.length >= MAX_SEGMENTS} onClick={addSegment}>
                Add segment
              </Button>
              {fieldError("segments")}
            </div>
          </div>

          <div className="min-w-0">
            <Field label="Brand voice notes (optional)" hint="Tone and wording to follow, for example plain and friendly.">
              <Textarea rows={3} value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} />
            </Field>
            {fieldError("brandVoice")}
          </div>

          <div className="min-w-0">
            <Field label="Prohibited claims (optional)" hint="Claims the copy must never make. Matching copy is flagged for review.">
              <Textarea rows={4} value={claims} onChange={(e) => setClaims(e.target.value)} placeholder="One claim per line" />
            </Field>
            {fieldError("prohibitedClaims")}
          </div>

          <div className="min-w-0">
            <Field label="Copy options per segment" hint="Each option has a headline, hook line, caption and call to action.">
              <Select value={copyPerSegment} onChange={(e) => setCopyPerSegment(Number(e.target.value))} className="max-w-[12rem]">
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            {fieldError("copyPerSegment")}
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">Base asset</h2>
          <Field label="Image file" hint="PNG, JPEG or WebP, up to 8 MB. The image provider makes the variants from this file.">
            <input
              type="file"
              required
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[13px] text-neutral-700 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-neutral-200 file:bg-white file:px-3 file:text-[13px] file:font-medium file:text-neutral-800 hover:file:bg-neutral-50"
            />
          </Field>
          {assetError && <p className="text-xs text-red-700">{assetError}</p>}
          {file && !assetError && (
            <p className="break-all text-xs text-neutral-500">
              {file.name}, {fmtBytes(file.size)}
            </p>
          )}
          <label className="flex items-start gap-2.5 rounded-md border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 text-[13px] text-neutral-800">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-neutral-300"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <span>I have the rights to adapt this asset</span>
          </label>
          <p className="text-xs text-neutral-500">The job won't run until this box is ticked.</p>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!complete && (
            <span className="mr-auto text-xs text-neutral-500">Fill in the brand, product and segment names, choose an image and tick the rights box.</span>
          )}
          <Button type="button" variant="ghost" onClick={() => navigate("/dco")}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {submitting ? "Creating job" : "Create variant job"}
          </Button>
        </div>
      </form>
    </Shell>
  );
}
