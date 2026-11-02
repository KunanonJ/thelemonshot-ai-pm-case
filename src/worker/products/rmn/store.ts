import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getDb } from "../../core/db/client";
import { errorMessage } from "../../core/env";
import { newId } from "../../core/util";
import { classifyUserAgent } from "./bots";
import { CATEGORIES, DEMO_PRODUCTS, findCategory, findProduct, STORE_BANNER, type DemoProduct } from "./catalog";
import { ATTRIBUTION_COOKIE, addClickId, CART_COOKIE, MAX_CART_LINES, parseCart, parseClickIds, serialiseIds } from "./cookies";
import { resolveLink } from "./links";
import { rmnClicks, rmnOrderTouchpoints, rmnSimulatedOrders, rmnStoreEvents } from "./schema";

type PublicContext = Context<{ Bindings: Env }>;

// Public by design: shoppers aren't users, so these routes sit outside /api and skip Clerk. They collect no personal data (BR-RM-1).
export const rmnPublicRoutes = new Hono<{ Bindings: Env }>();

// The attribution cookie lives as long as the longest window (30 days); the cart only for a day
const LIFETIME = { attribution: 30 * 86_400, cart: 86_400 };

function cookieOptions(c: PublicContext, maxAge: number) {
  return { path: "/", maxAge, httpOnly: true, sameSite: "Lax" as const, secure: new URL(c.req.url).protocol === "https:" };
}

const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const baht = (n: number) => `THB ${Math.round(n).toLocaleString("en-US")}`;
const isHuman = (c: PublicContext) => classifyUserAgent(c.req.header("user-agent")).uaClass === "human";

// Logging never holds up a visitor: the write completes after the response is sent (BR-RM-3, FR-RM-2)
function inBackground(c: PublicContext, write: PromiseLike<unknown>): void {
  c.executionCtx.waitUntil(Promise.resolve(write).catch((e) => console.error("rmn write failed", errorMessage(e))));
}

function referrerHostOf(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.slice(0, 120) || null;
  } catch {
    return null;
  }
}

function cartProducts(c: PublicContext): DemoProduct[] {
  return parseCart(getCookie(c, CART_COOKIE), (id) => findProduct(id) !== undefined).map((id) => findProduct(id)!);
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 Georgia,"Times New Roman",serif;background:#fbf7ef;color:#1b2440}
a{color:#1b3d8f}
.top{background:#1b2440;color:#fff;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:14px 20px}
.brand{color:#fff;font:700 15px system-ui,sans-serif;text-decoration:none;letter-spacing:.06em;text-transform:uppercase}
nav a{color:#fff;margin-left:16px;text-decoration:none;font:14px system-ui,sans-serif}
.notice{background:#ffd23f;color:#3b2a00;font:600 14px/1.4 system-ui,sans-serif;padding:10px 20px;border-bottom:2px solid #1b2440}
main{max-width:960px;margin:0 auto;padding:28px 20px 56px}
h1{font-size:26px;margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.card,.panel{display:block;background:#fff;border:1px solid #d9d2c3;border-radius:6px;padding:16px;color:#1b2440;text-decoration:none}
.price{font:600 15px system-ui,sans-serif}
.muted{color:#5b6378;font-size:14px}
button{font:600 14px system-ui,sans-serif;background:#1b2440;color:#fff;border:0;border-radius:4px;padding:9px 14px;cursor:pointer}
table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{text-align:left;padding:8px 6px;border-bottom:1px solid #e5dfd0}
.total{font:700 18px system-ui,sans-serif;margin-top:14px}
footer{max-width:960px;margin:0 auto;padding:0 20px 32px;color:#5b6378;font:13px system-ui,sans-serif}
`;

function page(c: PublicContext, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} | RMN Demo Store</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><a class="brand" href="/store">RMN Demo Store</a><nav><a href="/store">Products</a><a href="/store/cart">Cart (${cartProducts(c).length})</a></nav></header>
<div class="notice" role="note">${esc(STORE_BANNER)}</div>
<main>${body}</main>
<footer>Demo store for the Lemon Shot AI Suite. Products, prices and orders are simulated. No payment is taken and no personal details are collected.</footer>
</body>
</html>`;
}

// A neutral answer: it names no creator, campaign or product, so a dead or foreign link reveals nothing
function neutral(c: PublicContext, status: 404 | 410, message: string) {
  c.header("Cache-Control", "no-store");
  return c.html(page(c, "Link", `<section class="panel"><h1>${esc(message)}</h1><p class="muted">The RMN demo store takes no payments and sells simulated products.</p><p><a href="/store">Go to the demo store</a></p></section>`), status);
}

function productCard(p: DemoProduct): string {
  return `<a class="card" href="/store/p/${esc(p.id)}"><div style="font-weight:600">${esc(p.name)}</div><div class="muted">${esc(p.blurb)}</div><div class="price" style="margin-top:8px">${baht(p.priceThb)}</div></a>`;
}

// FR-RM-1 and BR-RM-3: the hot path is one KV read and a deferred log write. A disabled link is logged and answered neutrally.
rmnPublicRoutes.get("/r/:slug", async (c) => {
  const link = await resolveLink(c.env, c.req.param("slug"));
  if (!link) return neutral(c, 404, "This link isn't active.");
  const verdict = classifyUserAgent(c.req.header("user-agent"));
  const clickId = newId();
  const log = (result: "redirected" | "disabled") =>
    inBackground(
      c,
      getDb(c.env)
        .insert(rmnClicks)
        .values({
          id: clickId,
          linkId: link.linkId,
          campaignId: link.campaignId,
          creatorId: link.creatorId,
          result,
          uaClass: verdict.uaClass,
          botReason: verdict.reason,
          referrerHost: referrerHostOf(c.req.header("referer")),
          clickedAt: Date.now(),
        }),
    );
  if (link.disabled) {
    log("disabled");
    return neutral(c, 410, "This link has been turned off.");
  }
  log("redirected");
  // Only human visits join the attribution cookie, which carries click IDs and nothing else (BR-RM-1)
  if (verdict.uaClass === "human") {
    const ids = addClickId(parseClickIds(getCookie(c, ATTRIBUTION_COOKIE)), clickId);
    setCookie(c, ATTRIBUTION_COOKIE, serialiseIds(ids), cookieOptions(c, LIFETIME.attribution));
  }
  c.header("Cache-Control", "no-store");
  return c.redirect(link.landingPath, 302);
});

rmnPublicRoutes.get("/store", (c) => {
  const categories = CATEGORIES.map((cat) => {
    const count = DEMO_PRODUCTS.filter((p) => p.category === cat.id).length;
    return `<a class="card" href="/store/c/${cat.id}"><div style="font-weight:600;font-size:18px">${esc(cat.label)}</div><div class="muted">${count} demo products</div></a>`;
  }).join("");
  return c.html(page(c, "Products", `<h1>Demo products</h1><p class="muted">A small catalogue for the attribution demo. Prices are simulated.</p><div class="grid">${categories}</div>`));
});

rmnPublicRoutes.get("/store/c/:category", (c) => {
  const category = findCategory(c.req.param("category"));
  if (!category) return neutral(c, 404, "That category isn't in the demo store.");
  const items = DEMO_PRODUCTS.filter((p) => p.category === category.id).map(productCard).join("");
  return c.html(page(c, category.label, `<h1>${esc(category.label)}</h1><div class="grid">${items}</div>`));
});

// FR-RM-5: a product view is recorded for human visitors, tied to the click IDs in the attribution cookie
rmnPublicRoutes.get("/store/p/:product", (c) => {
  const product = findProduct(c.req.param("product"));
  if (!product) return neutral(c, 404, "That product isn't in the demo store.");
  if (isHuman(c)) {
    inBackground(
      c,
      getDb(c.env)
        .insert(rmnStoreEvents)
        .values({ id: newId(), kind: "view", productId: product.id, clickIds: parseClickIds(getCookie(c, ATTRIBUTION_COOKIE)), createdAt: Date.now() }),
    );
  }
  return c.html(
    page(
      c,
      product.name,
      `<h1>${esc(product.name)}</h1><p class="muted">${esc(product.blurb)}</p><p class="price">${baht(product.priceThb)}</p>` +
        `<form method="post" action="/store/cart/add"><button type="submit" name="product" value="${esc(product.id)}">Add to cart</button></form>` +
        `<p class="muted" style="margin-top:18px">Demo product. The price is simulated and nothing is charged.</p>`,
    ),
  );
});

rmnPublicRoutes.post("/store/cart/add", async (c) => {
  const form = await c.req.parseBody();
  const product = findProduct(String(form.product ?? ""));
  if (!product) return c.redirect("/store", 303);
  const lines = [...cartProducts(c).map((p) => p.id), product.id].slice(-MAX_CART_LINES);
  setCookie(c, CART_COOKIE, serialiseIds(lines), cookieOptions(c, LIFETIME.cart));
  if (isHuman(c)) {
    inBackground(
      c,
      getDb(c.env)
        .insert(rmnStoreEvents)
        .values({ id: newId(), kind: "add", productId: product.id, clickIds: parseClickIds(getCookie(c, ATTRIBUTION_COOKIE)), createdAt: Date.now() }),
    );
  }
  return c.redirect("/store/cart", 303);
});

// The cart page has no form fields at all: no payment details, no names, no emails (FR-RM-5, BR-RM-1)
rmnPublicRoutes.get("/store/cart", (c) => {
  const lines = cartProducts(c);
  const total = lines.reduce((sum, p) => sum + p.priceThb, 0);
  const body = lines.length
    ? `<h1>Cart</h1><table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody>${lines.map((p) => `<tr><td>${esc(p.name)}</td><td>${baht(p.priceThb)}</td></tr>`).join("")}</tbody></table>` +
      `<p class="total">Total ${baht(total)} (simulated)</p>` +
      `<form method="post" action="/store/checkout"><button type="submit">Place demo order</button></form>` +
      `<p class="muted">Simulated checkout. No payment is taken and no details are asked for. The order exists only in the attribution demo.</p>`
    : `<h1>Cart</h1><p class="muted">Your cart is empty. <a href="/store">Browse the demo products</a>.</p>`;
  return c.html(page(c, "Cart", body));
});

// FR-RM-4 and BR-RM-2: a demo checkout is a simulated outcome. It is tied to the human clicks in the attribution cookie
// and stored apart from creator history. Nothing is charged.
rmnPublicRoutes.post("/store/checkout", async (c) => {
  const products = cartProducts(c);
  if (products.length === 0) return c.redirect("/store/cart", 303);
  const db = getDb(c.env);
  const clickIds = parseClickIds(getCookie(c, ATTRIBUTION_COOKIE));
  // Only human, redirected clicks are touchpoints. A click ID with no matching log row yet is ignored.
  const touched = clickIds.length
    ? await db
        .select({ id: rmnClicks.id })
        .from(rmnClicks)
        .where(and(inArray(rmnClicks.id, clickIds), eq(rmnClicks.result, "redirected"), eq(rmnClicks.uaClass, "human")))
    : [];
  const orderId = newId();
  const statements: BatchItem<"sqlite">[] = [
    db.insert(rmnSimulatedOrders).values({
      id: orderId,
      items: products.map((p) => ({ productId: p.id, name: p.name, priceThb: p.priceThb })),
      revenueThb: products.reduce((sum, p) => sum + p.priceThb, 0),
      createdAt: Date.now(),
    }),
    ...touched.map((t) => db.insert(rmnOrderTouchpoints).values({ id: newId(), orderId, clickId: t.id })),
  ];
  await db.batch([statements[0]!, ...statements.slice(1)]);
  deleteCookie(c, CART_COOKIE, { path: "/" });
  return c.redirect(`/store/order/${orderId}`, 303);
});

rmnPublicRoutes.get("/store/order/:id", async (c) => {
  const [order] = await getDb(c.env).select().from(rmnSimulatedOrders).where(eq(rmnSimulatedOrders.id, c.req.param("id")));
  if (!order) return neutral(c, 404, "That order isn't in the demo store.");
  const rows = order.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${baht(i.priceThb)}</td></tr>`).join("");
  return c.html(
    page(
      c,
      "Order",
      `<h1>Demo order recorded</h1><p>This order is simulated. Nothing was charged.</p><table><tbody>${rows}</tbody></table>` +
        `<p class="total">Total ${baht(order.revenueThb)} (simulated)</p><p><a href="/store">Back to the demo products</a></p>`,
    ),
  );
});
