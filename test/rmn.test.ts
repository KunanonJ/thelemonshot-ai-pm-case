import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyUserAgent } from "../src/worker/products/rmn/bots";
import { addClickId, parseCart, parseClickIds, serialiseIds } from "../src/worker/products/rmn/cookies";
import { attributeOrder, DAY_MS, groupTouches, HALF_LIFE_DAYS, summariseAttribution, touchInWindow, validateWindowDays, type OrderTouches } from "../src/worker/products/rmn/attribution";
import { isKnownLanding, landingPath } from "../src/worker/products/rmn/catalog";
import { generateSlug, SLUG_ALPHABET, SLUG_LENGTH } from "../src/worker/products/rmn/slugs";
import {
  completenessNote,
  countDroppedWrite,
  decodeMapping,
  encodeMapping,
  LINK_CACHE_TTL_S,
  LINK_CACHE_WRITE,
  parseCount,
  propagationNote,
  readDroppedCount,
  readLinkCache,
  writeLinkCache,
} from "../src/worker/products/rmn/cache";
import { resolveLink, type LinkMapping } from "../src/worker/products/rmn/links";

// The D1 query behind resolveLink, replaced so the KV-to-D1 fallback can be tested without a database
const d1 = vi.hoisted(() => ({ rows: [] as unknown[], fail: false }));
vi.mock("../src/worker/core/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => {
            if (d1.fail) throw new Error("D1 unavailable");
            return d1.rows;
          },
        }),
      }),
    }),
  }),
}));

const T0 = Date.UTC(2026, 10, 1, 12);
const CLICK_A = "00000000-0000-4000-8000-00000000000a";
const CLICK_B = "00000000-0000-4000-8000-00000000000b";
const CLICK_C = "00000000-0000-4000-8000-00000000000c";

describe("link slugs (FR-RM-1)", () => {
  it("builds 12 symbols from a 32-symbol alphabet with no look-alikes", () => {
    expect(SLUG_ALPHABET).toHaveLength(32);
    expect(SLUG_ALPHABET).not.toMatch(/[01lo]/);
    const slug = generateSlug(() => new Uint8Array(SLUG_LENGTH).fill(0x2f));
    expect(slug).toHaveLength(SLUG_LENGTH);
    expect([...slug].every((ch) => SLUG_ALPHABET.includes(ch))).toBe(true);
  });

  it("maps every byte value evenly onto the alphabet", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const symbols = [...bytes].map((b) => generateSlug(() => new Uint8Array(SLUG_LENGTH).fill(b))[0]!);
    expect(new Set(symbols).size).toBe(32);
    expect(symbols.filter((s) => s === SLUG_ALPHABET[0]).length).toBe(8);
  });

  it("produces distinct slugs from the real random source", () => {
    const slugs = new Set(Array.from({ length: 5000 }, () => generateSlug()));
    expect(slugs.size).toBe(5000);
  });
});

describe("bot classification (FR-RM-2)", () => {
  it("flags known crawlers and automation with the reason", () => {
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({ uaClass: "bot", reason: "known bot: googlebot" });
    expect(classifyUserAgent("curl/8.4.0").uaClass).toBe("bot");
    expect(classifyUserAgent("python-requests/2.32.3").uaClass).toBe("bot");
    expect(classifyUserAgent("WhatsApp/2.23.20.0 A").uaClass).toBe("bot");
    expect(classifyUserAgent("HeadlessChrome/120.0.0.0 Safari/537.36").uaClass).toBe("bot");
  });

  it("treats a missing user agent as automation", () => {
    expect(classifyUserAgent(null)).toEqual({ uaClass: "bot", reason: "empty user agent" });
    expect(classifyUserAgent("   ")).toEqual({ uaClass: "bot", reason: "empty user agent" });
  });

  it("passes ordinary browsers", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(classifyUserAgent(chrome)).toEqual({ uaClass: "human", reason: null });
    expect(classifyUserAgent(iphone)).toEqual({ uaClass: "human", reason: null });
  });
});

describe("attribution window (FR-RM-3, AC-RM-2)", () => {
  it("accepts whole days from 1 to 30 only", () => {
    expect([1, 7, 30].every(validateWindowDays)).toBe(true);
    expect([0, 31, 7.5, Number.NaN].some(validateWindowDays)).toBe(false);
  });

  it("counts a click exactly on the window edge and drops it one millisecond later", () => {
    const edge = { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 7 * DAY_MS };
    expect(touchInWindow(edge, T0, 7)).toBe(true);
    expect(touchInWindow({ ...edge, clickedAt: edge.clickedAt - 1 }, T0, 7)).toBe(false);
  });

  it("never credits a click that happened after the order", () => {
    expect(touchInWindow({ clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 + 1 }, T0, 7)).toBe(false);
  });

  it("leaves a conversion 8 days after the only click unattributed and reports it", () => {
    const order: OrderTouches = { orderId: "o1", at: T0, revenue: 49, touches: [{ clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 8 * DAY_MS }] };
    expect(attributeOrder(order, 7, "last_click")).toEqual({ attributed: false, reason: "outside_window", revenue: 49 });
    const summary = summariseAttribution([order], 7);
    expect(summary).toMatchObject({ attributedOrders: 0, unattributedOrders: 1, unattributedRevenue: 49 });
    expect(summary.models.last_click.creators).toEqual({});
    expect(summary.models.time_decay.conversions).toBe(0);
  });

  it("uses only the in-window clicks when some are older than the window", () => {
    const order: OrderTouches = {
      orderId: "o2",
      at: T0,
      revenue: 100,
      touches: [
        { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 9 * DAY_MS },
        { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 - DAY_MS },
      ],
    };
    expect(attributeOrder(order, 7, "last_click")).toEqual({ attributed: true, shares: new Map([["fixture-2", 1]]), revenue: 100 });
  });
});

describe("attribution models (FR-RM-4, AC-RM-1)", () => {
  it("gives a single click the whole order under both models", () => {
    const order: OrderTouches = { orderId: "o1", at: T0, revenue: 49, touches: [{ clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 60_000 }] };
    for (const model of ["last_click", "time_decay"] as const) {
      const result = attributeOrder(order, 7, model);
      expect(result.attributed && [...result.shares.entries()]).toEqual([["fixture-1", 1]]);
    }
  });

  it("gives last-click the latest in-window click, whichever creator it was", () => {
    const order: OrderTouches = {
      orderId: "o1",
      at: T0,
      revenue: 49,
      touches: [
        { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 60_000 },
        { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 - 5_000 },
      ],
    };
    const result = attributeOrder(order, 7, "last_click");
    expect(result.attributed && [...result.shares.entries()]).toEqual([["fixture-2", 1]]);
  });

  it("splits time-decay by a 2-day half-life and normalises to 1 per order", () => {
    // A clicked one day before the order, B at the order: weights 0.5^(1/2) and 0.5^0
    const order: OrderTouches = {
      orderId: "o1",
      at: T0,
      revenue: 100,
      touches: [
        { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - DAY_MS },
        { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 },
      ],
    };
    const result = attributeOrder(order, 7, "time_decay");
    if (!result.attributed) throw new Error("expected attribution");
    const wA = Math.pow(0.5, 1 / HALF_LIFE_DAYS);
    expect(result.shares.get("fixture-1")).toBeCloseTo(wA / (wA + 1), 12);
    expect(result.shares.get("fixture-2")).toBeCloseTo(1 / (wA + 1), 12);
    expect([...result.shares.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
  });

  it("shows the same totals under both models and moves only the split", () => {
    const orders: OrderTouches[] = [
      { orderId: "o1", at: T0, revenue: 49, touches: [{ clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - DAY_MS }] },
      {
        orderId: "o2",
        at: T0 + 10_000,
        revenue: 89,
        touches: [
          { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - DAY_MS },
          { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 + 5_000 },
        ],
      },
    ];
    const s = summariseAttribution(orders, 7);
    expect(s.attributedOrders).toBe(2);
    expect(s.models.last_click.conversions).toBeCloseTo(2, 12);
    expect(s.models.time_decay.conversions).toBeCloseTo(2, 12);
    expect(s.models.last_click.revenue).toBeCloseTo(138, 9);
    expect(s.models.time_decay.revenue).toBeCloseTo(138, 9);
    expect(s.models.last_click.creators).toEqual({ "fixture-1": { conversions: 1, revenue: 49 }, "fixture-2": { conversions: 1, revenue: 89 } });
    // Time-decay gives creator 1 more than last-click does, taken from creator 2
    expect(s.models.time_decay.creators["fixture-1"]!.conversions).toBeGreaterThan(1);
    expect(s.models.time_decay.creators["fixture-2"]!.conversions).toBeLessThan(1);
  });

  it("credits a creator twice when two of their clicks land in the window", () => {
    const order: OrderTouches = {
      orderId: "o1",
      at: T0,
      revenue: 10,
      touches: [
        { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - DAY_MS },
        { clickId: CLICK_C, creatorId: "fixture-1", clickedAt: T0 - 1000 },
        { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 - 500 },
      ],
    };
    const td = summariseAttribution([order], 7).models.time_decay;
    expect(td.creators["fixture-1"]!.conversions + td.creators["fixture-2"]!.conversions).toBeCloseTo(1, 12);
    expect(td.creators["fixture-1"]!.conversions).toBeGreaterThan(td.creators["fixture-2"]!.conversions);
  });

  it("breaks an exact timestamp tie by click ID so the result never changes between reads", () => {
    const order: OrderTouches = {
      orderId: "o1",
      at: T0,
      revenue: 1,
      touches: [
        { clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 - 100 },
        { clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 100 },
      ],
    };
    const result = attributeOrder(order, 7, "last_click");
    expect(result.attributed && [...result.shares.keys()]).toEqual(["fixture-2"]);
  });
});

describe("touchpoint grouping", () => {
  it("rebuilds one order per id with its own time and revenue", () => {
    const orders = groupTouches([
      { orderId: "o1", at: T0, revenue: 49, clickId: CLICK_A, creatorId: "fixture-1", clickedAt: T0 - 1 },
      { orderId: "o1", at: T0, revenue: 49, clickId: CLICK_B, creatorId: "fixture-2", clickedAt: T0 - 2 },
      { orderId: "o2", at: T0 + 1, revenue: 89, clickId: CLICK_C, creatorId: "fixture-3", clickedAt: T0 },
    ]);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ orderId: "o1", revenue: 49 });
    expect(orders[0]!.touches.map((t) => t.creatorId)).toEqual(["fixture-1", "fixture-2"]);
  });
});

describe("attribution cookie and cart (BR-RM-1)", () => {
  it("keeps only well-formed click IDs, deduplicated, at most ten", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const raw = ["not-an-id", ...ids, ids[3]].join(".");
    const parsed = parseClickIds(raw);
    expect(parsed).toHaveLength(10);
    expect(parsed).not.toContain("not-an-id");
    expect(parsed[parsed.length - 1]).toBe(ids[11]);
    expect(parseClickIds(undefined)).toEqual([]);
  });

  it("moves a repeated click to the newest position", () => {
    expect(addClickId([CLICK_A, CLICK_B], CLICK_A)).toEqual([CLICK_B, CLICK_A]);
    expect(serialiseIds([CLICK_A, CLICK_B])).toBe(`${CLICK_A}.${CLICK_B}`);
  });

  it("keeps only catalogue products in the cart", () => {
    const known = (id: string) => id.startsWith("p-");
    expect(parseCart("p-a.evil=1.p-b", known)).toEqual(["p-a", "p-b"]);
  });
});

describe("catalogue landing targets (FR-RM-5)", () => {
  it("accepts a known product or category and builds the store path", () => {
    expect(isKnownLanding("product", "p-seaweed-chips")).toBe(true);
    expect(isKnownLanding("category", "beauty")).toBe(true);
    expect(isKnownLanding("category", "p-seaweed-chips")).toBe(false);
    expect(landingPath("product", "p-seaweed-chips")).toBe("/store/p/p-seaweed-chips");
    expect(landingPath("category", "beauty")).toBe("/store/c/beauty");
  });
});

const MAPPING: LinkMapping = { linkId: "link-1", campaignId: "camp-1", creatorId: "fixture-1", variant: null, disabled: false, landingPath: "/store/p/p-seaweed-chips" };
const ROW = { link: { id: "link-1", campaignId: "camp-1", creatorId: "fixture-1", variant: null, disabled: false }, landingKind: "product", landingId: "p-seaweed-chips" };

// A KV stand-in. Failing calls throw, as a KV outage does; successful writes are recorded for assertions
function fakeKv(opts: { failGet?: boolean; failPut?: boolean; stored?: Record<string, string> } = {}) {
  const store = new Map(Object.entries(opts.stored ?? {}));
  const puts: { key: string; value: string; options?: unknown }[] = [];
  const kv = {
    async get(key: string) {
      if (opts.failGet) throw new Error("KV read failed");
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: unknown) {
      if (opts.failPut) throw new Error("KV write failed");
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as Pick<KVNamespace, "get" | "put">, puts };
}

describe("link cache TTL and entry shape (FR-RM-1, BR-RM-3)", () => {
  it("expires cache entries after ten minutes, above the 60 second minimum KV accepts", () => {
    expect(LINK_CACHE_TTL_S).toBe(600);
    expect(LINK_CACHE_TTL_S).toBeGreaterThanOrEqual(60);
    expect(LINK_CACHE_WRITE).toEqual({ expirationTtl: 600 });
  });

  it("round-trips a mapping and treats any malformed entry as a miss", () => {
    expect(decodeMapping(encodeMapping(MAPPING))).toEqual(MAPPING);
    expect(decodeMapping(null)).toBeNull();
    expect(decodeMapping("{not json")).toBeNull();
    expect(decodeMapping(JSON.stringify({ ...MAPPING, disabled: "false" }))).toBeNull();
    expect(decodeMapping(JSON.stringify({ ...MAPPING, disabled: undefined }))).toBeNull();
    expect(decodeMapping(JSON.stringify({ ...MAPPING, variant: 3 }))).toBeNull();
    expect(decodeMapping(JSON.stringify({ ...MAPPING, landingPath: "https://example.com/" }))).toBeNull();
  });
});

describe("KV failures never reach the shopper (BR-RM-3, BR-CORE-3)", () => {
  beforeEach(() => {
    d1.rows = [];
    d1.fail = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads a cached mapping, and treats a KV read error or a corrupt entry as a miss", async () => {
    expect(await readLinkCache(fakeKv({ stored: { "rmn:link:abc": encodeMapping(MAPPING) } }).kv, "abc")).toEqual(MAPPING);
    expect(await readLinkCache(fakeKv({ failGet: true }).kv, "abc")).toBeNull();
    expect(await readLinkCache(fakeKv({ stored: { "rmn:link:abc": "{oops" } }).kv, "abc")).toBeNull();
  });

  it("writes with the ten minute TTL, and reports a failed write without throwing", async () => {
    const ok = fakeKv();
    expect(await writeLinkCache(ok.kv, "abc", MAPPING)).toBe(true);
    expect(ok.puts).toEqual([{ key: "rmn:link:abc", value: JSON.stringify(MAPPING), options: { expirationTtl: 600 } }]);
    expect(await writeLinkCache(fakeKv({ failPut: true }).kv, "abc", MAPPING)).toBe(false);
  });

  it("falls through to D1 when the KV read fails, and warms the cache with the TTL", async () => {
    d1.rows = [ROW];
    const f = fakeKv({ failGet: true });
    expect(await resolveLink({ CONFIG: f.kv, DB: {} } as unknown as Env, "abc")).toEqual(MAPPING);
    expect(f.puts).toEqual([{ key: "rmn:link:abc", value: JSON.stringify(MAPPING), options: { expirationTtl: 600 } }]);
  });

  it("still answers with the mapping when the cache warm-up also fails", async () => {
    d1.rows = [ROW];
    const env = { CONFIG: fakeKv({ failGet: true, failPut: true }).kv, DB: {} } as unknown as Env;
    expect(await resolveLink(env, "abc")).toEqual(MAPPING);
  });

  it("answers from the cache without a D1 read", async () => {
    d1.fail = true;
    const env = { CONFIG: fakeKv({ stored: { "rmn:link:abc": encodeMapping(MAPPING) } }).kv, DB: {} } as unknown as Env;
    expect(await resolveLink(env, "abc")).toEqual(MAPPING);
  });

  it("lets a D1 error reach the caller, and returns null for an unknown slug", async () => {
    d1.fail = true;
    await expect(resolveLink({ CONFIG: fakeKv().kv, DB: {} } as unknown as Env, "abc")).rejects.toThrow("D1 unavailable");
    d1.fail = false;
    expect(await resolveLink({ CONFIG: fakeKv().kv, DB: {} } as unknown as Env, "zzz")).toBeNull();
  });
});

describe("dropped write counts and completeness note (BR-CORE-2)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts each dropped write against its own campaign", async () => {
    const f = fakeKv();
    expect(await readDroppedCount(f.kv, "camp-1")).toBe(0);
    expect(await countDroppedWrite(f.kv, "camp-1")).toBe(true);
    expect(await countDroppedWrite(f.kv, "camp-1")).toBe(true);
    expect(await countDroppedWrite(f.kv, "camp-2")).toBe(true);
    expect(await readDroppedCount(f.kv, "camp-1")).toBe(2);
    expect(await readDroppedCount(f.kv, "camp-2")).toBe(1);
  });

  it("reports an unreadable counter as unknown rather than zero", async () => {
    expect(await readDroppedCount(fakeKv({ failGet: true }).kv, "camp-1")).toBeNull();
    expect(await countDroppedWrite(fakeKv({ failPut: true }).kv, "camp-1")).toBe(false);
  });

  it("accepts only plain whole numbers from the counter", () => {
    expect(parseCount("0")).toBe(0);
    expect(parseCount("4")).toBe(4);
    for (const bad of ["", "-1", "1e3", "2.5", "many"]) expect(parseCount(bad)).toBeNull();
  });

  it("writes a plain sentence for none, one, several, and an unreadable counter", () => {
    expect(completenessNote(0)).toBeNull();
    expect(completenessNote(1)).toBe("1 click or store event was not saved, so these counts may be lower than the real numbers.");
    expect(completenessNote(3)).toBe("3 clicks or store events were not saved, so these counts may be lower than the real numbers.");
    expect(completenessNote(null)).toContain("could not check");
  });
});

describe("cache propagation note and wording (BR-RM-3, BR-CORE-3)", () => {
  it("says how long a failed cache update can take, in plain words", () => {
    expect(propagationNote(LINK_CACHE_TTL_S)).toBe(
      "The change is saved, but the cached copy could not be updated, so it may take up to 10 minutes to reach every location.",
    );
    expect(propagationNote(60)).toContain("up to 1 minute to reach");
  });

  it("uses no em dashes in any note", () => {
    for (const note of [completenessNote(1), completenessNote(2), completenessNote(null), propagationNote(600)]) {
      expect(note).not.toMatch(/[‒-―]/);
    }
  });
});
