// FR-DC-1 intake checks and the short-lived link that lets fal read a base asset without a Clerk session.

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export type AssetType = { contentType: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp" };

const PNG: AssetType = { contentType: "image/png", ext: "png" };
const JPEG: AssetType = { contentType: "image/jpeg", ext: "jpg" };
const WEBP: AssetType = { contentType: "image/webp", ext: "webp" };

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

// Checks the file's own signature, not the browser's declared type, so a renamed file is refused
export function sniffAsset(bytes: Uint8Array): AssetType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return PNG;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return JPEG;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return WEBP;
  return null;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// Fal reads the input over plain HTTP. The link is a 256-bit random token mapped to the asset in KV for two hours.
export const FAL_INPUT_TTL_S = 2 * 60 * 60;
export const TOKEN_RE = /^[0-9a-f]{64}$/;

export const inputKey = (token: string) => `dco:input:${token}`;

export function mintToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function mintInputLink(env: Env, origin: string, asset: { r2Key: string; contentType: string }): Promise<string> {
  const token = mintToken();
  await env.CONFIG.put(inputKey(token), JSON.stringify({ r2Key: asset.r2Key, contentType: asset.contentType }), { expirationTtl: FAL_INPUT_TTL_S });
  return `${origin}/api/dco/public/input/${token}`;
}

// Keeps only plain filename characters, so the value is safe to echo in JSON and in a download name
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return cleaned || "base-asset";
}
