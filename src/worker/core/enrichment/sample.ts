import type { PostMetrics } from "./posts";
import type { ParsedPost } from "../../products/trends/parse";
import type { TrendPlatform } from "../../products/trends/schema";

// Sample sources: stand-ins for Apify where the real source can't be used, so a demo still runs every product
// end to end. Everything here is invented and deterministic (the same input gives the same numbers), and every
// caller labels it as sample data.
// - Campaign Optimization uses it for posts by seeded demo creators (creators.source = 'seed'), which are
//   fictional, so there is nothing real to fetch.
// - Trend Monitoring uses it only while an admin has the "demo:sample-sources" setting on.

export const SAMPLE_SOURCES_KEY = "demo:sample-sources";
export const SAMPLE_TERM_NOTE = "Sample posts: invented for the demo, because live pulls need Apify Store access. Every handle starts with demo_.";

const DAY_MS = 86_400_000;

// FNV-1a, so the same key always gives the same number, in [0, 1)
export function unit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4_294_967_296;
}

export async function sampleSourcesOn(env: Env): Promise<boolean> {
  return (await env.CONFIG.get(SAMPLE_SOURCES_KEY).catch(() => null)) === "1";
}

// A tracked post's metrics at a moment: views grow towards a ceiling over its first week, and each post gets its
// own strength, so a campaign has clear winners and laggards.
export function samplePostMetrics(contentId: string, postedAt: number | null, now: number): PostMetrics {
  const strength = 0.35 + 1.4 * unit(`${contentId}:strength`); // 0.35x–1.75x
  const ceiling = Math.round((12_000 + 180_000 * unit(`${contentId}:reach`)) * strength);
  const ageDays = Math.max(0, (now - (postedAt ?? now - 3 * DAY_MS)) / DAY_MS);
  const grown = 1 - Math.exp(-(ageDays + 0.5) / 2.5);
  const views = Math.round(ceiling * grown);
  const er = 0.025 + 0.07 * unit(`${contentId}:er`) * Math.min(1.4, strength);
  const likes = Math.round(views * er);
  return { views, likes, comments: Math.round(likes * (0.02 + 0.03 * unit(`${contentId}:c`))), shares: Math.round(likes * (0.03 + 0.06 * unit(`${contentId}:s`))) };
}

// Themes a pull can find, by category. Each post carries the watched term plus one theme's hashtags, so
// clustering (themes seeded by a hashtag shared by two or more posts) has something real to work with.
const THEMES: Record<string, { tags: string[]; lines: string[] }[]> = {
  food_snacks: [
    { tags: ["ขนมใหม่", "รีวิวขนม", "newsnack"], lines: ["ลองขนมใหม่ที่เพิ่งออก กรอบกว่าที่คิด", "New flavour drop: is it worth 35 baht?", "รีวิวขนมใหม่ 5 ซองในงบร้อย"] },
    { tags: ["asmr", "crunch", "เสียงกรอบ"], lines: ["ASMR crunch test, no talking", "เสียงกรอบชัดๆ กินโชว์ตอนดึก", "Which chip has the loudest crunch?"] },
    { tags: ["officesnack", "ขนมออฟฟิศ", "workbreak"], lines: ["ขนมกินเล่นช่วงบ่ายในออฟฟิศ", "Ranking our office pantry snacks", "Snack break between meetings"] },
    { tags: ["sourflavor", "รสเปรี้ยว", "lemon"], lines: ["รสเปรี้ยวมะนาวกำลังมา", "Sour-salt is the flavour of the season", "ลองขนมรสมะนาวทุกยี่ห้อ"] },
    { tags: ["studysnack", "ขนมอ่านหนังสือ"], lines: ["ขนมเพื่อนคู่หูช่วงสอบ", "What I snack on during exam week"] },
  ],
  beauty: [
    { tags: ["skincare", "สกินแคร์", "glassskin"], lines: ["สกินแคร์ 3 ขั้นตอนก่อนนอน", "Glass skin routine under 500 baht"] },
    { tags: ["liptint", "ลิปติดทน"], lines: ["ลิปติดทนแม้กินข้าว", "Lip tint wear test: 8 hours"] },
    { tags: ["sunscreen", "กันแดด"], lines: ["กันแดดที่ไม่เหนียวสำหรับอากาศร้อน", "Sunscreen that survives Bangkok humidity"] },
  ],
};
const HANDLES = ["demo_snackscout", "demo_crunchdiary", "demo_bkkbites", "demo_munchmate", "demo_flavourfeed", "demo_snacklab.th", "demo_tastetrail", "demo_dailynibble", "demo_glowroutine", "demo_campuseats"];

// Up to `cap` invented posts for one watched term on one platform, most of them from the last week
export function sampleTrendPosts(term: { term: string; category: string }, platform: TrendPlatform, cap: number, now: number): ParsedPost[] {
  const themes = THEMES[term.category] ?? THEMES.food_snacks!;
  const tag = term.term.replace(/^#+/, "").toLowerCase().replace(/\s+/g, "");
  const n = Math.max(0, Math.min(cap, 18));
  const posts: ParsedPost[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${platform}:${tag}:${i}`;
    const theme = themes[i % themes.length]!;
    const handle = HANDLES[Math.floor(unit(`${key}:h`) * HANDLES.length)]!;
    const id = `${Math.floor(7_400_000_000_000_000_000 + unit(`${key}:id`) * 1e17)}`.slice(0, 19);
    const ageDays = unit(`${key}:age`) < 0.65 ? unit(`${key}:a1`) * 7 : 7 + unit(`${key}:a2`) * 14;
    const views = Math.round((4_000 + 240_000 * unit(`${key}:v`) ** 2) * (i % themes.length === 3 ? 1.8 : 1));
    const likes = Math.round(views * (0.03 + 0.06 * unit(`${key}:l`)));
    const hashtags = [tag, ...theme.tags.slice(0, 1 + Math.floor(unit(`${key}:t`) * theme.tags.length))];
    posts.push({
      platform,
      platformPostId: platform === "tiktok" ? id : `DEMO${id.slice(-8)}`,
      url: platform === "tiktok" ? `https://www.tiktok.com/@${handle}/video/${id}` : `https://www.instagram.com/p/DEMO${id.slice(-8)}/`,
      handle,
      caption: `${theme.lines[i % theme.lines.length]} ${hashtags.map((h) => `#${h}`).join(" ")}`,
      hashtags,
      postedAt: Math.round(now - ageDays * DAY_MS),
      likes,
      comments: Math.round(likes * 0.04),
      views,
      shares: Math.round(likes * 0.06),
    });
  }
  return posts;
}
