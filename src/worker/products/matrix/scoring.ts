import type { Objective } from "./brief";
import type { CandidateFeatures } from "./features";
import { COMPONENTS, RULES, WEIGHT_PROFILES, type Component } from "./weights";

export type Dims = { audienceFit: number; brandSafety: number; creativeFit: number };
export type ExcludedReason = "safety_excluded" | "no_data";

export type ScoredRow = {
  creatorId: string;
  composite: number | null;
  components: Record<Component, number | null>;
  dims: Dims | null;
  flags: string[];
  excludedReason: ExcludedReason | null;
  recommended: boolean;
  rank: number | null;
};

// FR-MX-6: weighted blend of data features and LLM dimensions. Missing components drop out and the
// remaining weights are rescaled, so a cold-start creator isn't scored as if their history were zero.
export function composite(components: Record<Component, number | null>, weights: Record<Component, number>): number | null {
  let total = 0;
  let used = 0;
  for (const c of COMPONENTS) {
    const v = components[c];
    if (v === null) continue;
    total += weights[c] * v;
    used += weights[c];
  }
  return used > 0 ? Math.round((total / used) * 10) / 10 : null;
}

export function rankCandidates(input: {
  features: CandidateFeatures[];
  dims: Map<string, Dims> | null; // null: the LLM was unavailable for this run (BR-MX-2)
  llmFlags: Map<string, string[]>;
  objective: Objective;
  mustInclude: Set<string>;
}): ScoredRow[] {
  const weights = WEIGHT_PROFILES[input.objective];
  const rows: ScoredRow[] = input.features.map((f) => {
    const dims = input.dims?.get(f.creatorId) ?? null;
    const components: Record<Component, number | null> = {
      history: f.history,
      engagement: f.engagement,
      reach: f.reach,
      categoryFit: f.categoryFit,
      audienceFit: dims?.audienceFit ?? null,
      creativeFit: dims?.creativeFit ?? null,
    };
    const flags = [...(input.llmFlags.get(f.creatorId) ?? [])];
    if (!dims) flags.push("rationale_unavailable");
    if (f.completeness < RULES.confidenceThreshold) flags.push("low_confidence");
    if (f.history === null) flags.push("cold_start");
    if (f.stalenessDays !== null && f.stalenessDays > RULES.staleAfterDays) flags.push("stale_data");
    if (input.mustInclude.has(f.creatorId)) flags.push("must_include");

    // FR-MX-8: no usable data means no shortlist place; FR-MX-6: the safety floor beats any composite
    let excludedReason: ExcludedReason | null = null;
    if (!f.usable) excludedReason = "no_data";
    else if (dims && dims.brandSafety < RULES.brandSafetyFloor) excludedReason = "safety_excluded";

    return {
      creatorId: f.creatorId,
      composite: f.usable ? composite(components, weights) : null,
      components,
      dims,
      flags: [...new Set(flags)],
      excludedReason,
      recommended: false,
      rank: null,
    };
  });

  const byScore = (a: ScoredRow, b: ScoredRow) =>
    (b.composite ?? -1) - (a.composite ?? -1) || (a.creatorId < b.creatorId ? -1 : 1);
  const eligible = rows.filter((r) => r.excludedReason === null).sort(byScore);
  // Must-include creators take places first; the rest fill by score; the list is shown in score order
  const forced = eligible.filter((r) => input.mustInclude.has(r.creatorId));
  const rest = eligible.filter((r) => !input.mustInclude.has(r.creatorId));
  const shortlist = [...forced, ...rest].slice(0, Math.max(RULES.shortlistSize, forced.length)).sort(byScore);
  shortlist.forEach((r, i) => {
    r.recommended = true;
    r.rank = i + 1;
  });
  return rows;
}
