import { desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../core/auth";
import { getDb } from "../core/db/client";
import { creators, deadLetters } from "../core/db/schema";
import { requestEnrichment } from "../core/enrichment/service";
import { newId, normaliseHandle } from "../core/util";

export const creatorRoutes = new Hono<AppEnv>();

type LatestSnapshot = { creator_id: string; platform: string; followers: number | null; engagement_rate: number | null; median_views: number | null; fetched_at: number };

// Roster with the latest snapshot per platform; sample records carry is_sample for the UI label (HR-1)
creatorRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(creators).orderBy(desc(creators.createdAt));
  const { results: snaps } = await c.env.DB.prepare(
    `SELECT s.creator_id, s.platform, s.followers, s.engagement_rate, s.median_views, s.fetched_at
     FROM stat_snapshots s
     JOIN (SELECT creator_id, platform, MAX(fetched_at) AS latest FROM stat_snapshots GROUP BY creator_id, platform) l
       ON l.creator_id = s.creator_id AND l.platform = s.platform AND l.latest = s.fetched_at`,
  ).all<LatestSnapshot>();
  const byCreator = new Map<string, LatestSnapshot[]>();
  for (const s of snaps) byCreator.set(s.creator_id, [...(byCreator.get(s.creator_id) ?? []), s]);
  return c.json(rows.map((r) => ({ ...r, snapshots: byCreator.get(r.id) ?? [] })));
});

const handle = z
  .string()
  .trim()
  .max(80)
  .transform((h) => (h ? normaliseHandle(h) : ""))
  .optional();

const addSchema = z
  .object({
    displayName: z.string().trim().max(120).optional(),
    categories: z.array(z.string().trim().min(1)).min(1),
    instagram: handle,
    tiktok: handle,
    youtube: handle,
  })
  .refine((v) => v.instagram || v.tiktok || v.youtube, "Give at least one handle");

// FR-CORE-7: add a creator by handle; enrichment is queued and the creator becomes scoreable when the first snapshot lands
creatorRoutes.post("/", requireRole("admin"), async (c) => {
  const parsed = addSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_creator", issues: parsed.error.issues.map((i) => i.message) }, 400);
  const v = parsed.data;
  const now = Date.now();
  const id = newId();
  try {
    await getDb(c.env)
      .insert(creators)
      .values({
        id,
        displayName: v.displayName || v.instagram || v.tiktok || v.youtube || "Unnamed creator",
        categories: v.categories,
        instagram: v.instagram || null,
        tiktok: v.tiktok || null,
        youtube: v.youtube || null,
        pastBrands: [],
        collaborationFlags: [],
        source: "manual",
        // Everything in this deployment is sample data, never a real agency database (HR-1)
        isSample: true,
        active: true,
        enrichmentStatus: "pending",
        createdBy: c.get("userId"),
        createdAt: now,
        updatedAt: now,
      });
  } catch {
    return c.json({ error: "handle_already_in_roster" }, 409);
  }
  await requestEnrichment(c.env, [id], "add", c.get("userId"));
  return c.json({ id }, 201);
});

creatorRoutes.post("/:id/refresh", requireRole("admin"), async (c) => {
  const jobs = await requestEnrichment(c.env, [c.req.param("id")], "manual", c.get("userId"));
  return c.json({ queued: jobs });
});

const patchSchema = z.object({ active: z.boolean().optional(), categories: z.array(z.string().trim().min(1)).min(1).optional() });

creatorRoutes.patch("/:id", requireRole("admin"), async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_update" }, 400);
  await getDb(c.env)
    .update(creators)
    .set({ ...parsed.data, updatedAt: Date.now() })
    .where(eq(creators.id, c.req.param("id")));
  return c.json({ ok: true });
});

// Only the fields the Creators page shows. The stored detail holds raw per-platform errors, which stay with operators.
creatorRoutes.get("/dead-letters", requireRole("admin", "member"), async (c) => {
  const rows = await getDb(c.env)
    .select({
      id: deadLetters.id,
      kind: deadLetters.kind,
      reason: deadLetters.reason,
      platform: deadLetters.platform,
      createdAt: deadLetters.createdAt,
      creatorName: creators.displayName,
    })
    .from(deadLetters)
    .leftJoin(creators, eq(deadLetters.creatorId, creators.id))
    .where(isNull(deadLetters.resolvedAt))
    .orderBy(desc(deadLetters.createdAt))
    .limit(100);
  return c.json(rows);
});
