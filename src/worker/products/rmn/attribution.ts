// FR-RM-3 and FR-RM-4: attribution under two models. Pure: no D1, no clock. All times are epoch milliseconds.
// AC-RM-1 and AC-RM-2 are checked against this module by the unit tests and by the end-to-end script.

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = { min: 1, max: 30, default: 7 } as const;
// Time-decay: a click's weight halves for every two days between the click and the order
export const HALF_LIFE_DAYS = 2;
export const MODELS = ["last_click", "time_decay"] as const;
export type Model = (typeof MODELS)[number];

export type Touch = { clickId: string; creatorId: string; clickedAt: number };
export type OrderTouches = { orderId: string; at: number; revenue: number; touches: Touch[] };

export function validateWindowDays(value: number): boolean {
  return Number.isInteger(value) && value >= WINDOW_DAYS.min && value <= WINDOW_DAYS.max;
}

// A click counts when it happened no later than the order and no more than the window before it (both ends inclusive)
export function touchInWindow(touch: Touch, orderAt: number, windowDays: number): boolean {
  const age = orderAt - touch.clickedAt;
  return age >= 0 && age <= windowDays * DAY_MS;
}

export type Attribution = { attributed: true; shares: Map<string, number>; revenue: number } | { attributed: false; reason: "outside_window"; revenue: number };

// Last-click gives the whole order to the latest in-window click. Time-decay weights every in-window click by
// 0.5^(age in days / HALF_LIFE_DAYS) and normalises the weights, so each order is credited exactly once.
export function attributeOrder(order: OrderTouches, windowDays: number, model: Model): Attribution {
  const live = order.touches.filter((t) => touchInWindow(t, order.at, windowDays)).sort(byClickTime);
  if (live.length === 0) return { attributed: false, reason: "outside_window", revenue: order.revenue };
  const shares = new Map<string, number>();
  if (model === "last_click") {
    shares.set(live[live.length - 1]!.creatorId, 1);
  } else {
    const weights = live.map((t) => Math.pow(0.5, (order.at - t.clickedAt) / DAY_MS / HALF_LIFE_DAYS));
    const total = weights.reduce((sum, w) => sum + w, 0);
    live.forEach((t, i) => shares.set(t.creatorId, (shares.get(t.creatorId) ?? 0) + weights[i]! / total));
  }
  return { attributed: true, shares, revenue: order.revenue };
}

function byClickTime(a: Touch, b: Touch): number {
  if (a.clickedAt !== b.clickedAt) return a.clickedAt - b.clickedAt;
  return a.clickId < b.clickId ? -1 : a.clickId > b.clickId ? 1 : 0;
}

export type CreatorTotals = { conversions: number; revenue: number };
export type ModelTotals = CreatorTotals & { creators: Record<string, CreatorTotals> };
export type AttributionSummary = {
  attributedOrders: number;
  attributedRevenue: number;
  // FR-RM-3: orders that had clicks from the campaign, all of them outside the window. Reported, never credited.
  unattributedOrders: number;
  unattributedRevenue: number;
  models: Record<Model, ModelTotals>;
};

export function summariseAttribution(orders: OrderTouches[], windowDays: number): AttributionSummary {
  const models = { last_click: emptyTotals(), time_decay: emptyTotals() } as Record<Model, ModelTotals>;
  const summary: AttributionSummary = { attributedOrders: 0, attributedRevenue: 0, unattributedOrders: 0, unattributedRevenue: 0, models };
  for (const order of orders) {
    if (!order.touches.some((t) => touchInWindow(t, order.at, windowDays))) {
      summary.unattributedOrders += 1;
      summary.unattributedRevenue += order.revenue;
      continue;
    }
    summary.attributedOrders += 1;
    summary.attributedRevenue += order.revenue;
    for (const model of MODELS) {
      const result = attributeOrder(order, windowDays, model);
      if (!result.attributed) continue;
      const totals = models[model];
      for (const [creatorId, share] of result.shares) {
        const row = (totals.creators[creatorId] ??= { conversions: 0, revenue: 0 });
        row.conversions += share;
        row.revenue += order.revenue * share;
        totals.conversions += share;
        totals.revenue += order.revenue * share;
      }
    }
  }
  return summary;
}

function emptyTotals(): ModelTotals {
  return { conversions: 0, revenue: 0, creators: {} };
}

export type TouchRow = { orderId: string; at: number; revenue: number; clickId: string; creatorId: string; clickedAt: number };

// Joins touchpoint rows back into one entry per order, keeping the order's own time and revenue
export function groupTouches(rows: TouchRow[]): OrderTouches[] {
  const byOrder = new Map<string, OrderTouches>();
  for (const row of rows) {
    const order = byOrder.get(row.orderId) ?? { orderId: row.orderId, at: row.at, revenue: row.revenue, touches: [] };
    order.touches.push({ clickId: row.clickId, creatorId: row.creatorId, clickedAt: row.clickedAt });
    byOrder.set(row.orderId, order);
  }
  return [...byOrder.values()];
}
