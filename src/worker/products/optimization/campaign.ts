import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../core/db/client";
import { contentItems, creators, type Platform } from "../../core/db/schema";
import { parsePostUrl } from "../../core/enrichment/posts";
import { newId, normaliseHandle } from "../../core/util";

// Workflow step 1: name, brand, an optional linked ① run, tracked posts with optional baselines, and dates.
// Dates are calendar days in Bangkok time.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-03");

export const campaignSchema = z
  .object({
    name: z.string().trim().min(1, "Name the campaign").max(120),
    brand: z.string().trim().min(1, "Brand is required").max(120),
    matrixRunId: z.string().min(1).optional(),
    startsOn: day,
    endsOn: day,
    posts: z
      .array(
        z.object({
          url: z.string().trim().min(1).max(500),
          // Instagram and YouTube post URLs don't say whose post it is; TikTok URLs do
          handle: z.string().trim().max(80).optional(),
          creatorId: z.string().min(1).optional(),
          baselineViews: z.number().int().min(0).optional(),
          baselineEngagementRate: z.number().min(0).max(100).optional(),
        }),
      )
      .min(1, "Track at least one post")
      .max(50),
  })
  .refine((c) => c.endsOn >= c.startsOn, { path: ["endsOn"], message: "The end date is before the start date" });

export type CampaignInput = z.infer<typeof campaignSchema>;

export const startOfDay = (d: string) => Date.parse(`${d}T00:00:00+07:00`);
export const endOfDay = (d: string) => Date.parse(`${d}T23:59:59.999+07:00`);

export type ResolvedPost = {
  creatorId: string;
  contentId: string;
  platform: Platform;
  platformPostId: string;
  url: string;
  baselineViews: number | null;
  baselineEngagementRate: number | null;
};
export type PostProblem = { index: number; error: string };

type CreatorRow = typeof creators.$inferSelect;

// FR-CO-1: every tracked post resolves to a creator in the spine, or a stub creator is created for enrichment
export async function resolvePosts(
  db: Db,
  posts: CampaignInput["posts"],
  userId: string,
): Promise<{ resolved: ResolvedPost[]; stubs: (typeof creators.$inferInsert)[]; problems: PostProblem[] }> {
  const problems: PostProblem[] = [];
  const parsed = posts.map((p, index) => ({ index, input: p, post: parsePostUrl(p.url) }));
  for (const x of parsed) {
    if (!x.post) problems.push({ index: x.index, error: "Not an Instagram, TikTok or YouTube post URL" });
    else if (!x.post.handle && !x.input.handle && !x.input.creatorId) problems.push({ index: x.index, error: "Add the creator's handle: this URL doesn't include it" });
  }
  const seen = new Set<string>();
  for (const x of parsed) {
    if (!x.post) continue;
    const key = `${x.post.platform}:${x.post.postId}`;
    if (seen.has(key)) problems.push({ index: x.index, error: "This post is already in the list" });
    seen.add(key);
  }
  if (problems.length) return { resolved: [], stubs: [], problems };

  const ids = parsed.flatMap((x) => (x.input.creatorId ? [x.input.creatorId] : []));
  const byId = new Map((ids.length ? await db.select().from(creators).where(inArray(creators.id, ids)) : []).map((c) => [c.id, c]));
  const existingContent = new Map(
    (await db.select().from(contentItems).where(inArray(contentItems.id, [...seen]))).map((c) => [c.id, c]),
  );
  const stubs = new Map<string, typeof creators.$inferInsert>();
  const now = Date.now();
  const resolved: ResolvedPost[] = [];

  for (const { index, input, post } of parsed) {
    const p = post!;
    const contentId = `${p.platform}:${p.postId}`;
    let creator: Pick<CreatorRow, "id"> | undefined;
    if (input.creatorId) {
      creator = byId.get(input.creatorId);
      if (!creator) {
        problems.push({ index, error: "Unknown creator" });
        continue;
      }
    } else {
      const handle = normaliseHandle(input.handle || p.handle!);
      const key = `${p.platform}:${handle}`;
      const [found] = await db.select({ id: creators.id }).from(creators).where(eq(creators[p.platform], handle)).limit(1);
      creator = found ?? (stubs.get(key) as Pick<CreatorRow, "id"> | undefined);
      if (!creator) {
        // A stub keeps the post tracked; enrichment fills in the profile. Planner-added creators are sample data (HR-1).
        const stub = {
          id: newId(),
          displayName: `@${handle}`,
          categories: [],
          instagram: p.platform === "instagram" ? handle : null,
          tiktok: p.platform === "tiktok" ? handle : null,
          youtube: p.platform === "youtube" ? handle : null,
          pastBrands: [],
          collaborationFlags: [],
          source: "manual" as const,
          isSample: true,
          active: true,
          enrichmentStatus: "pending" as const,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        } satisfies typeof creators.$inferInsert;
        stubs.set(key, stub);
        creator = stub;
      }
    }
    const existing = existingContent.get(contentId);
    if (existing && existing.creatorId !== creator.id) {
      problems.push({ index, error: "This post is already on record for a different creator" });
      continue;
    }
    resolved.push({
      creatorId: creator.id,
      contentId,
      platform: p.platform,
      platformPostId: p.postId,
      url: p.url,
      baselineViews: input.baselineViews ?? null,
      baselineEngagementRate: input.baselineEngagementRate ?? null,
    });
  }
  return { resolved, stubs: [...stubs.values()], problems };
}
