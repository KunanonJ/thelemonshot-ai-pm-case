// FR-RM-1: unique, unguessable link slugs. 12 symbols from a 32-symbol alphabet give 60 bits of randomness.
// The alphabet drops 0, 1, l and o so a slug copied by hand isn't ambiguous. Uniqueness is enforced by a
// unique index on rmn_links.slug.
export const SLUG_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
export const SLUG_LENGTH = 12;

export function generateSlug(randomBytes: (n: number) => Uint8Array = secureBytes): string {
  // 256 is a multiple of 32, so masking each byte with 31 picks every symbol with equal probability
  return [...randomBytes(SLUG_LENGTH)].map((b) => SLUG_ALPHABET[b & 31]).join("");
}

function secureBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
