import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb, type Db } from "../../core/db/client";
import { campaigns, creators, outcomeRecords, runLogs, runs } from "../../core/db/schema";
import { inputHash, newId } from "../../core/util";
import { closingSummary, HISTORY_VERSION, historyScore, OUTCOME_VERSION, type OutcomeRow } from "./deltas";
import { loadDeltas } from "./digest";

// Workflow step 6, FR-CO-7 and FR-CORE-21: the planner confirms a per-creator outcome summary, then one
// transaction writes outcome records and recomputes each creator's history score, which ① reads next run.

export async function closePreview(db: Db, campaignId: string): Promise<{ rows: OutcomeRow[]; hash: string }> {
  const rows = closingSummary((await loadDeltas(db, campaignId, Date.now())).deltas);
  // The hash lets the close refuse numbers that changed after the planner reviewed them
  return { rows, hash: await inputHash({ rows, outcomeVersion: OUTCOME_VERSION }) };
}

export type WriteBack = {
  runId: string;
  outcomeVersion: string;
  historyVersion: string;
  creators: { creatorId: string; outcomeScore: number; before: number | null; after: number | null }[];
  unscored: string[];
};

export async function closeCampaign(env: Env, campaignId: string, userId: string, confirmedHash: string): Promise<{ writeBack: WriteBack } | { error: string }> {
  const db = getDb(env);
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return { error: "not_found" };
  if (campaign.status !== "active") return { error: "campaign_not_active" };
  const { rows, hash } = await closePreview(db, campaignId);
  if (hash !== confirmedHash) return { error: "summary_changed" };

  const scored = rows.filter((r) => r.outcomeScore !== null);
  const ids = scored.map((r) => r.creatorId);
  const prior = ids.length ? await db.select({ creatorId: outcomeRecords.creatorId, score: outcomeRecords.outcomeScore }).from(outcomeRecords).where(inArray(outcomeRecords.creatorId, ids)) : [];
  const before = ids.length ? await db.select({ id: creators.id, historyScore: creators.historyScore }).from(creators).where(inArray(creators.id, ids)) : [];
  // Deterministic run ID: a second close collides on it and the whole batch rolls back
  const runId = `writeback-${campaignId}`;
  const writeBack: WriteBack = {
    runId,
    outcomeVersion: OUTCOME_VERSION,
    historyVersion: HISTORY_VERSION,
    creators: scored.map((r) => ({
      creatorId: r.creatorId,
      outcomeScore: r.outcomeScore!,
      before: before.find((b) => b.id === r.creatorId)?.historyScore ?? null,
      after: historyScore([...prior.filter((p) => p.creatorId === r.creatorId).map((p) => p.score), r.outcomeScore!]),
    })),
    unscored: rows.filter((r) => r.outcomeScore === null).map((r) => r.creatorId),
  };

  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [
    db.insert(runs).values({
      id: runId,
      product: "optimization",
      status: "approved",
      inputHash: hash,
      flags: { kind: "write_back", campaignId },
      createdBy: userId,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      reviewedBy: userId,
      reviewedAt: now,
    }),
    ...scored.map((r) =>
      db.insert(outcomeRecords).values({
        id: newId(),
        creatorId: r.creatorId,
        campaignRef: campaignId,
        outcomeScore: r.outcomeScore!,
        detail: { ...r, campaign: campaign.name },
        scoringVersion: OUTCOME_VERSION,
        createdBy: userId,
        createdAt: now,
      }),
    ),
    ...writeBack.creators.map((c) => db.update(creators).set({ historyScore: c.after, historyVersion: HISTORY_VERSION, updatedAt: now }).where(eq(creators.id, c.creatorId))),
    db
      .update(campaigns)
      .set({ status: "closed", outcome: { rows, writeBack }, closedBy: userId, closedAt: now, updatedAt: now })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "active"))),
    db.insert(runLogs).values({ id: newId(), runId, kind: "decision", payload: { decision: "close", campaignId, rows, writeBack }, actor: userId, createdAt: now }),
  ];
  try {
    await db.batch([statements[0]!, ...statements.slice(1)]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) return { error: "campaign_not_active" };
    throw e;
  }
  return { writeBack };
}

// FR-CORE-21 "recomputable": rebuilds every history score from the outcome records alone
export async function recomputeHistory(env: Env): Promise<{ creators: number; changed: number }> {
  const db = getDb(env);
  const all = await db.select({ creatorId: outcomeRecords.creatorId, score: outcomeRecords.outcomeScore }).from(outcomeRecords);
  const byCreator = new Map<string, number[]>();
  for (const r of all) byCreator.set(r.creatorId, [...(byCreator.get(r.creatorId) ?? []), r.score]);
  const ids = [...byCreator.keys()];
  const current = ids.length ? await db.select({ id: creators.id, historyScore: creators.historyScore }).from(creators).where(inArray(creators.id, ids)) : [];
  let changed = 0;
  for (const c of current) {
    const next = historyScore(byCreator.get(c.id)!);
    if (next === c.historyScore) continue;
    changed++;
    await db.update(creators).set({ historyScore: next, historyVersion: HISTORY_VERSION, updatedAt: Date.now() }).where(eq(creators.id, c.id));
  }
  return { creators: ids.length, changed };
}
