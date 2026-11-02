// HR-3 / FR-CP-3 and FR-CP-2 applied to model text after schema validation and before anything is stored.
// A performance figure must trace to an input; a creator outside the attached shortlist is never named.
// Lint flags change nothing: they point the reviewer at wording (BR-CP-3, the gate is the control).

import { guardFigures } from "../../core/figures";

export { allowedFigures, findFigures, guardFigures, isSupported, type Figure } from "../../core/figures";

// ---------- creators ----------

export const CREATOR_PLACEHOLDER = "(creator TBC)";
// Shorter names collide with ordinary words ("Mint", "Bow"); the prompt is the first control, this is the backstop
const MIN_NAME_LENGTH = 6;
const MENTION_RE = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_](?:[\p{L}\p{N}._]{0,28}[\p{L}\p{N}_])?)/gu;
const THAI = /[฀-๿]/;

export type CreatorGuard = { allowedHandles: Set<string>; latin: RegExp | null; thai: RegExp | null };
type People = { names: string[]; handles: string[] };

// `allowed` may be named (the shortlist, in the creator section); `others` may not. `keep` protects the
// brand and product names from ever being treated as a creator.
export function makeCreatorGuard(allowed: People, others: People, keep: string[]): CreatorGuard {
  const lower = (s: string) => s.trim().replace(/^@/, "").toLowerCase();
  const allowedSet = new Set([...allowed.names, ...allowed.handles].map(lower));
  const keepText = keep.join(" ").toLowerCase();
  const blocked = [...new Set([...others.names, ...others.handles].map(lower))].filter(
    (p) => p.length >= MIN_NAME_LENGTH && !allowedSet.has(p) && !keepText.includes(p),
  );
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternation = (list: string[]) => list.sort((a, b) => b.length - a.length).map(escape).join("|");
  const latin = blocked.filter((p) => !THAI.test(p));
  const thai = blocked.filter((p) => THAI.test(p));
  return {
    allowedHandles: new Set(allowed.handles.map(lower)),
    latin: latin.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation(latin)})(?![\\p{L}\\p{N}_])`, "giu") : null,
    // Thai script has no spaces between words, so Thai names match anywhere
    thai: thai.length ? new RegExp(alternation(thai), "giu") : null,
  };
}

export function guardCreators(text: string, g: CreatorGuard): { text: string; removed: number } {
  let removed = 0;
  const swap = () => {
    removed++;
    return CREATOR_PLACEHOLDER;
  };
  let out = text.replace(MENTION_RE, (raw, handle: string) => (g.allowedHandles.has(handle.toLowerCase()) ? raw : swap()));
  if (g.latin) out = out.replace(g.latin, swap);
  if (g.thai) out = out.replace(g.thai, swap);
  return { text: out, removed };
}

// ---------- lint (flags only) ----------

const SUPERLATIVES_LATIN = /(?<!\p{L})(?:best|number one|no\. ?1|#1|guarantee[ds]?|unbeatable|the only|ultimate|world[- ]class|perfect)(?!\p{L})/iu;
const SUPERLATIVES_THAI = /ที่สุด|อันดับหนึ่ง|อันดับ 1|การันตี|รับประกัน/u;

export function lintText(text: string, mustAvoid: string[]): string[] {
  const flags: string[] = [];
  if (SUPERLATIVES_LATIN.test(text) || SUPERLATIVES_THAI.test(text)) flags.push("superlatives");
  const lower = text.toLowerCase();
  for (const topic of mustAvoid) if (topic.trim() && lower.includes(topic.trim().toLowerCase())) flags.push(`avoid:${topic.trim()}`);
  return flags;
}

// ---------- whole sections ----------

export type GuardContext = { figures: number[]; creators: CreatorGuard; mustAvoid: string[] };

// Cleans every string the model wrote (IDs excepted) and says what changed
export function guardModelOutput<T>(value: T, ctx: GuardContext): { value: T; flags: string[] } {
  let figures = 0;
  let creators = 0;
  const lint = new Set<string>();
  const visit = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key === "creatorId") return v;
      const f = guardFigures(v, ctx.figures);
      const c = guardCreators(f.text, ctx.creators);
      figures += f.replaced;
      creators += c.removed;
      for (const flag of lintText(c.text, ctx.mustAvoid)) lint.add(flag);
      return c.text;
    }
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  const cleaned = visit(value) as T;
  return {
    value: cleaned,
    flags: [...(figures ? [`figures_replaced:${figures}`] : []), ...(creators ? [`creators_removed:${creators}`] : []), ...lint],
  };
}

// A planner's own words are theirs to stand behind; edits are only linted, never rewritten
export function lintContent(value: unknown, mustAvoid: string[]): string[] {
  const flags = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") for (const f of lintText(v, mustAvoid)) flags.add(f);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return [...flags];
}

// Adds a creators_removed count to flags that may already carry one
export function addRemovedCreators(flags: string[], extra: number): string[] {
  if (!extra) return flags;
  const existing = flags.find((f) => f.startsWith("creators_removed:"));
  const total = (existing ? Number(existing.split(":")[1]) : 0) + extra;
  return [...flags.filter((f) => f !== existing), `creators_removed:${total}`];
}
