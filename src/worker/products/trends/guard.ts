// HR-3 and FR-TM-3 applied to model text after schema validation and before anything is stored.
// Platform-wide wording is rejected, not rewritten: the deterministic sentence is kept instead and the brief says so.
// A figure that doesn't trace to the pulled data becomes "TBC" (the shared figures guard).

import { guardFigures } from "../../core/figures";

const PLATFORM_WIDE =
  /\b(?:platform[- ]wide|across (?:the )?(?:whole )?(?:platform|tiktok|instagram|social media)|on (?:tiktok|instagram) (?:overall|as a whole|in general)|(?:all|every|most|many) (?:tiktok|instagram) (?:users|creators|accounts|audiences|people)|everyone on|market[- ]wide|industry[- ]wide|nationwide|country[- ]wide|in thailand (?:overall|as a whole|in general)|trending (?:on|across) (?:tiktok|instagram)|the whole (?:platform|internet)|users in general|most (?:people|users) (?:are|use|watch|buy|search))\b/i;
const PLATFORM_WIDE_TH = /ทั้งแพลตฟอร์ม|ทั่วทั้งแพลตฟอร์ม|ทั่วประเทศ|ทุกคนบน/u;

export function platformWideWording(text: string): boolean {
  return PLATFORM_WIDE.test(text) || PLATFORM_WIDE_TH.test(text);
}

export type GuardedText = { text: string | null; figuresReplaced: number; platformWide: boolean };

export function guardTrendText(text: string, allowed: number[]): GuardedText {
  const clean = text.trim();
  if (!clean) return { text: null, figuresReplaced: 0, platformWide: false };
  if (platformWideWording(clean)) return { text: null, figuresReplaced: 0, platformWide: true };
  const g = guardFigures(clean, allowed);
  return { text: g.text, figuresReplaced: g.replaced, platformWide: false };
}

// FR-CORE-17: captions reach the model without links, e-mail addresses or phone numbers
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\+?\d[\d -]{7,}\d/g;

export function sanitiseExcerpt(text: string, max = 140): string {
  const clean = text.replace(URL_RE, "[link]").replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[number]").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}
