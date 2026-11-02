// ⑥ demo store catalogue. Fictional products and simulated prices (HR-1, HR-2): never a real retailer's range.
export const RMN_SCOPE = "The tracking and attribution engine is real. The storefront and its sales are simulated.";
export const STORE_BANNER = "RMN Demo Store: simulated checkout, no real payment.";

export const CATEGORIES = [
  { id: "food_snacks", label: "Food & snacks" },
  { id: "beauty", label: "Beauty" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

export type DemoProduct = { id: string; name: string; category: CategoryId; priceThb: number; blurb: string };

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { id: "p-seaweed-chips", name: "Demo Seaweed Chips, original (40 g)", category: "food_snacks", priceThb: 49, blurb: "Thin, crisp and lightly salted." },
  { id: "p-mango-slices", name: "Demo Dried Mango Slices (80 g)", category: "food_snacks", priceThb: 89, blurb: "Chewy slices with no added sugar." },
  { id: "p-coconut-crisps", name: "Demo Coconut Crisps, lightly salted (50 g)", category: "food_snacks", priceThb: 59, blurb: "Baked coconut flakes in a sharing bag." },
  { id: "p-rose-lip-balm", name: "Demo Rose Lip Balm (4 g)", category: "beauty", priceThb: 129, blurb: "A tinted balm for dry lips." },
  { id: "p-sun-mist", name: "Demo Sunscreen Mist SPF 50 (100 ml)", category: "beauty", priceThb: 249, blurb: "Light mist for face and neck." },
  { id: "p-hydrating-mist", name: "Demo Hydrating Face Mist (100 ml)", category: "beauty", priceThb: 199, blurb: "Cooling mist to refresh the skin." },
];

export type LandingKind = "product" | "category";

export function findProduct(id: string): DemoProduct | undefined {
  return DEMO_PRODUCTS.find((p) => p.id === id);
}

export function findCategory(id: string): (typeof CATEGORIES)[number] | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function isKnownLanding(kind: LandingKind, id: string): boolean {
  return kind === "product" ? findProduct(id) !== undefined : findCategory(id) !== undefined;
}

export function landingPath(kind: LandingKind, id: string): string {
  return kind === "product" ? `/store/p/${id}` : `/store/c/${id}`;
}

export function landingLabel(kind: LandingKind, id: string): string {
  return kind === "product" ? (findProduct(id)?.name ?? id) : (findCategory(id)?.label ?? id);
}
