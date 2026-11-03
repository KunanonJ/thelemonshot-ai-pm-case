// FR-RM-3 and BR-RM-1: the first-party attribution cookie carries click IDs and nothing else. No names, emails or
// device data. The cart cookie carries catalogue product IDs only.
export const ATTRIBUTION_COOKIE = "rmn_attr";
export const CART_COOKIE = "rmn_cart";
export const MAX_TOUCHES = 10;
export const MAX_CART_LINES = 10;
const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEPARATOR = ".";

// Anything that isn't a click ID is dropped, so a hand-edited cookie can't name a click it never received
export function parseClickIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const ids = raw.split(SEPARATOR).filter((id) => CLICK_ID.test(id));
  return [...new Set(ids)].slice(-MAX_TOUCHES);
}

// The newest click goes last; the cookie keeps at most MAX_TOUCHES click IDs
export function addClickId(current: string[], clickId: string): string[] {
  return [...current.filter((id) => id !== clickId), clickId].slice(-MAX_TOUCHES);
}

export function parseCart(raw: string | null | undefined, isKnownProduct: (id: string) => boolean): string[] {
  if (!raw) return [];
  return raw
    .split(SEPARATOR)
    .filter((id) => isKnownProduct(id))
    .slice(0, MAX_CART_LINES);
}

export function serialiseIds(ids: string[]): string {
  return ids.join(SEPARATOR);
}
