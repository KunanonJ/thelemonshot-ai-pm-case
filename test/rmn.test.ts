import { describe, expect, it } from "vitest";
import { classifyUserAgent } from "../src/worker/products/rmn/bots";
import { addClickId, parseCart, parseClickIds, serialiseIds } from "../src/worker/products/rmn/cookies";
import { attributeOrder, DAY_MS, groupTouches, HALF_LIFE_DAYS, summariseAttribution, touchInWindow, validateWindowDays, type OrderTouches } from "../src/worker/products/rmn/attribution";
import { isKnownLanding, landingPath } from "../src/worker/products/rmn/catalog";
import { generateSlug, SLUG_ALPHABET, SLUG_LENGTH } from "../src/worker/products/rmn/slugs";

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
