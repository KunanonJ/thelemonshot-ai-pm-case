// FR-DC-2 and AC-DC-2. This list is the only set of image models DCO can call, and it holds scene, background
// and layout models only. Adding a model is a code change that goes through this file and the audit test; it is
// never a UI setting. Each entry was checked against fal's own model page on the date shown.

export type AllowedModel = {
  id: string;
  role: "layout" | "scene";
  description: string;
  docs: string;
  verifiedOn: string;
  // What the provider's documented output says about safety filtering (BR-DC-2 checks generic flags too)
  providerSafetyField: string;
};

export const FAL_ALLOWLIST: readonly AllowedModel[] = [
  {
    id: "fal-ai/bria/expand",
    role: "layout",
    description: "Extends the canvas to a new aspect ratio and fills the new area with background",
    docs: "https://fal.ai/models/fal-ai/bria/expand/api",
    verifiedOn: "2026-11-02",
    providerSafetyField: "None documented on this endpoint",
  },
  {
    id: "fal-ai/bria/background/replace",
    role: "scene",
    description: "Replaces the background behind the product and keeps the product in place",
    docs: "https://fal.ai/models/fal-ai/bria/background/replace/api",
    verifiedOn: "2026-11-02",
    providerSafetyField: "None documented on this endpoint",
  },
  {
    id: "fal-ai/bria/product-shot",
    role: "scene",
    description: "Places the product in a new setting described in plain English",
    docs: "https://fal.ai/models/fal-ai/bria/product-shot/api",
    verifiedOn: "2026-11-02",
    providerSafetyField: "None documented on this endpoint",
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

// AC-DC-2: fails if an entry is listed twice, is not a fal-ai model path, or names a blocked category
export function auditAllowlist(models: readonly AllowedModel[]): AllowlistAudit {
  const violations: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) violations.push({ id: m.id, reason: "Listed more than once" });
    seen.add(m.id);
    if (!/^fal-ai\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(m.id)) violations.push({ id: m.id, reason: "Not a fal-ai model path" });
    const text = `${m.id} ${m.role} ${m.description}`;
    for (const p of BLOCKED_PATTERNS) if (p.re.test(text)) violations.push({ id: m.id, reason: `Matches a blocked pattern: ${p.label}` });
  }
  return { ok: violations.length === 0, checked: models.length, violations };
}

export function allowedModel(id: string): AllowedModel | null {
  return FAL_ALLOWLIST.find((m) => m.id === id) ?? null;
}

// Called before every provider submission, so a plan entry that is not allowlisted can never be sent
export function assertAllowed(id: string): AllowedModel {
  const model = allowedModel(id);
  if (!model) throw new Error(`model not on the DCO allowlist: ${id}`);
  return model;
}

export function allowlistView() {
  return { models: FAL_ALLOWLIST, blockedFamilies: BLOCKED_FAMILIES, audit: auditAllowlist(FAL_ALLOWLIST) };
}
