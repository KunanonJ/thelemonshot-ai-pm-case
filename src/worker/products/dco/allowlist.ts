// FR-DC-2 and AC-DC-2. This list is the only set of image models DCO can call. Adding a model is a code change that
// goes through this file and the audit test; it is never a UI setting. Each entry was checked against the provider's
// own model page on the date shown.
//
// Since 4 Nov 2026 the plan runs on Cloudflare Workers AI (free within the daily allowance) instead of fal.ai. FLUX.2
// [klein] is a general image model, not a product-only one, so it is marked generalPurpose: it is only ever sent the
// uploaded product photo (with the planner's rights attestation) and the fixed prompts in visuals.ts, which rule out
// people, faces and hands, and every result is a draft until a person approves it. The fal.ai client stays in fal.ts
// for when the Bria product models are funded again; they are not on this list, so nothing can call them.

export type AllowedModel = {
  id: string;
  role: "layout" | "scene" | "layout and scene";
  // A model that could render anything, kept to product edits by the fixed prompts and the input it is given
  generalPurpose: boolean;
  description: string;
  docs: string;
  verifiedOn: string;
  // What the provider's documented output says about safety filtering (BR-DC-2 checks generic flags too)
  providerSafetyField: string;
};

export const IMAGE_ALLOWLIST: readonly AllowedModel[] = [
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    role: "layout and scene",
    generalPurpose: true,
    description: "Edits the uploaded product photo into a new format or setting from a fixed prompt",
    docs: "https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/",
    verifiedOn: "2026-11-04",
    providerSafetyField: "None documented on this model",
  },
];

// Categories the governing rule rules out. They are described here, never added to the allowlist.
export const BLOCKED_FAMILIES = ["Face generation", "Face swap", "Person synthesis", "Avatar, portrait or headshot generation", "Voice cloning"] as const;

const BLOCKED_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "face", re: /\bfaces?\b|\bfacial\b|\bface[-_]?(swap|id|gen)/i },
  { label: "swap", re: /\bswap/i },
  { label: "person", re: /\bpersons?\b|\bpeople\b|\bperson[-_]?synth/i },
  { label: "portrait", re: /\bportraits?\b/i },
  { label: "avatar", re: /\bavatars?\b/i },
  { label: "headshot", re: /\bheadshots?\b/i },
  { label: "likeness", re: /\blikeness\b|\bdeepfake|\bvoice[-_]?clon/i },
];

export type AllowlistAudit = { ok: boolean; checked: number; violations: { id: string; reason: string }[] };

// AC-DC-2: fails if an entry is listed twice, is not a fal-ai or Workers AI model path, or names a blocked category
export function auditAllowlist(models: readonly AllowedModel[]): AllowlistAudit {
  const violations: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) violations.push({ id: m.id, reason: "Listed more than once" });
    seen.add(m.id);
    if (!/^(fal-ai\/[a-z0-9-]+(\/[a-z0-9-]+)*|@cf\/[a-z0-9-]+\/[a-z0-9.-]+)$/.test(m.id)) violations.push({ id: m.id, reason: "Not a fal-ai or Workers AI model path" });
    const text = `${m.id} ${m.role} ${m.description}`;
    for (const p of BLOCKED_PATTERNS) if (p.re.test(text)) violations.push({ id: m.id, reason: `Matches a blocked pattern: ${p.label}` });
  }
  return { ok: violations.length === 0, checked: models.length, violations };
}

export function allowedModel(id: string): AllowedModel | null {
  return IMAGE_ALLOWLIST.find((m) => m.id === id) ?? null;
}

// Called before every provider submission, so a plan entry that is not allowlisted can never be sent
export function assertAllowed(id: string): AllowedModel {
  const model = allowedModel(id);
  if (!model) throw new Error(`model not on the DCO allowlist: ${id}`);
  return model;
}

export function allowlistView() {
  return { models: IMAGE_ALLOWLIST, blockedFamilies: BLOCKED_FAMILIES, audit: auditAllowlist(IMAGE_ALLOWLIST) };
}
