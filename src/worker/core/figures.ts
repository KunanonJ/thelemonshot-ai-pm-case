// HR-3 for every product that lets a model write prose: a performance figure must trace to an input.
// Used by ④ proposals and ③ digests.

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

// Figures in text carry no sign ("35% below", "1,200 fewer views"), so they match an input's magnitude
export function isSupported(value: number, allowed: number[]): boolean {
  return allowed.some((v) => (v === 0 ? value === 0 : Math.abs(value - Math.abs(v)) / Math.abs(v) <= TOLERANCE));
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
