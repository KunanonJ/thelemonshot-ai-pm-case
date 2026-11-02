// HR-3 / FR-CP-3 and FR-CP-2 applied to model text after schema validation and before anything is stored.
// A performance figure must trace to an input; a creator outside the attached shortlist is never named.
// Lint flags change nothing: they point the reviewer at wording (BR-CP-3, the gate is the control).

const MAGNITUDE: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  พัน: 1e3,
  หมื่น: 1e4,
  แสน: 1e5,
  ล้าน: 1e6,
};
// "125K" for 125,400 followers is rounding, not a new figure
const TOLERANCE = 0.05;

// A number plus whatever makes it a figure: currency, percent, multiple or magnitude. Digits inside
// words or handles ("Q4", "v2", "abc123") are skipped by the lookbehind.
const NUMBER_RE =
  /(?<![\p{L}\p{N}_.])(฿|THB ?|USD ?|US\$|\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?: ?(%|percent|เปอร์เซ็นต์|×|x(?!\p{L})|k(?!\p{L})|mn(?!\p{L})|m(?!\p{L})|million|bn(?!\p{L})|b(?!\p{L})|billion|พัน|หมื่น|แสน|ล้าน))?(?: ?(baht|บาท|THB))?/giu;

export type Figure = { raw: string; index: number; value: number; kind: "money" | "percent" | "multiple" | "count" };

// Small plain numbers ("3 pillars", "Week 2") and years are structure, not performance figures
export function findFigures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [raw, currency, int, decimals, suffix, currencyAfter] = m;
    const base = Number(int!.replace(/,/g, "") + (decimals ?? ""));
    const unit = suffix?.toLowerCase();
    const money = Boolean(currency || currencyAfter);
    let figure: Pick<Figure, "value" | "kind"> | null = null;
    if (unit === "%" || unit === "percent" || unit === "เปอร์เซ็นต์") figure = { value: base, kind: "percent" };
    else if (unit === "x" || unit === "×") figure = { value: base, kind: "multiple" };
    else if (unit && MAGNITUDE[unit]) figure = { value: base * MAGNITUDE[unit], kind: money ? "money" : "count" };
    else if (money) figure = { value: base, kind: "money" };
    else if (base >= 1000 && !(decimals === undefined && /^(19|20)\d\d$/.test(int!))) figure = { value: base, kind: "count" };
    if (figure) out.push({ raw: raw.trimEnd(), index: m.index, ...figure });
  }
  return out;
}

export function isSupported(value: number, allowed: number[]): boolean {
  return allowed.some((v) => (v === 0 ? value === 0 : Math.abs(value - v) / Math.abs(v) <= TOLERANCE));
}

export function guardFigures(text: string, allowed: number[]): { text: string; replaced: number } {
  let out = "";
  let last = 0;
  let replaced = 0;
  for (const f of findFigures(text)) {
    if (isSupported(f.value, allowed)) continue;
    out += `${text.slice(last, f.index)}TBC`;
    last = f.index + f.raw.length;
    replaced++;
  }
  return { text: out + text.slice(last), replaced };
}

// Every figure the model may repeat: numbers from the data plus figures written in the inputs' text
export function allowedFigures(numbers: (number | null | undefined)[], texts: string[]): number[] {
  const out = numbers.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  for (const text of texts) out.push(...findFigures(text).map((f) => f.value));
  return out;
}

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
