import { getDb } from "../../core/db/client";
import { newId } from "../../core/util";
import { dcoEvents } from "./schema";
import { buildZip, type ZipEntry } from "./zip";
import { toDetail, type DcoDetailView, type DcoRows } from "./view";

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");

// CSV cells that a spreadsheet would read as a formula are prefixed, and quoted when they hold a delimiter
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");

// The copy sheet holds approved copy only; a line nobody approved never leaves the tool
export function copySheetCsv(detail: DcoDetailView): string {
  const names = new Map(detail.segments.map((s) => [s.key, s.name]));
  const header = ["Segment", "Option", "Headline", "Hook line", "Caption", "CTA", "Flags", "Model", "Created"];
  const lines = detail.copy
    .filter((c) => c.reviewStatus === "approved")
    .map((c) => csvLine([names.get(c.segmentKey) ?? c.segmentKey, c.position, c.headline, c.hookLine, c.caption, c.cta, c.flags.join("; "), c.model, iso(c.createdAt)]));
  return [csvLine(header), ...lines].join("\r\n") + "\r\n";
}

// FR-DC-4: every generated visual and every copy option, with what made it and who reviewed it
export function provenanceCsv(detail: DcoDetailView): string {
  const names = new Map(detail.segments.map((s) => [s.key, s.name]));
  const header = [
    "Type",
    "Key",
    "Segment",
    "Kind",
    "Format",
    "Model",
    "Status",
    "Review status",
    "Reviewed by",
    "Reviewed at",
    "Prompt version",
    "Prompt",
    "Negative prompt",
    "Seed",
    "Fal request id",
    "Input sha256",
    "Output sha256",
    "Output bytes",
    "Submitted at",
    "Completed at",
    "Job id",
    "Error or flags",
  ];
  const visualRows = detail.visuals.map((v) =>
    csvLine([
      "visual",
      v.key,
      names.get(v.segmentKey) ?? v.segmentKey,
      v.kind,
      v.format,
      v.modelId,
      v.status,
      v.reviewStatus,
      v.reviewedBy ?? "",
      iso(v.reviewedAt),
      v.provenance?.promptVersion ?? "",
      v.provenance?.prompt ?? "",
      v.provenance?.negativePrompt ?? "",
      v.provenance?.seed ?? (v.provenance ? "not returned by the model" : ""),
      v.provenance?.falRequestId ?? "",
      v.provenance?.inputSha256 ?? "",
      v.provenance?.outputSha256 ?? "",
      v.provenance?.outputBytes ?? "",
      iso(v.provenance?.submittedAt),
      iso(v.provenance?.completedAt),
      detail.id,
      v.error ?? "",
    ]),
  );
  const copyRows = detail.copy.map((c) =>
    csvLine([
      "copy",
      c.id,
      names.get(c.segmentKey) ?? c.segmentKey,
      "copy option",
      "",
      c.model,
      "generated",
      c.reviewStatus,
      c.reviewedBy ?? "",
      iso(c.reviewedAt),
      c.promptVersion,
      `Copy rubric ${c.promptVersion} applied to the job brief`,
      "",
      "",
      "",
      "",
      "",
      "",
      iso(c.createdAt),
      "",
      detail.id,
      c.flags.join("; "),
    ]),
  );
  return [csvLine(header), ...visualRows, ...copyRows].join("\r\n") + "\r\n";
}

// The pack holds approved visuals only, plus both sheets. Each export is logged with the files it contained.
export async function buildDcoPack(env: Env, rows: DcoRows, actor: string): Promise<{ zip: Uint8Array; names: string[] }> {
  const detail = toDetail(rows);
  const encoder = new TextEncoder();
  const approved = rows.visuals.filter((v) => v.reviewStatus === "approved" && v.status === "ready" && v.r2Key);
  const files: ZipEntry[] = [];
  for (const v of approved) {
    const obj = await env.FILES.get(v.r2Key!);
    if (!obj) throw new Error(`stored image missing for ${v.planKey}`);
    const ext = v.r2Key!.split(".").pop() ?? "bin";
    files.push({ name: `visuals/${v.planKey}.${ext}`, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  files.push({ name: "copy-sheet.csv", data: encoder.encode(copySheetCsv(detail)) });
  files.push({ name: "provenance.csv", data: encoder.encode(provenanceCsv(detail)) });
  const names = files.map((f) => f.name);
  await getDb(env)
    .insert(dcoEvents)
    .values({
      id: newId(),
      runId: rows.run.id,
      kind: "export",
      payload: { files: names, visuals: approved.map((v) => v.planKey), approvedCopy: detail.copy.filter((c) => c.reviewStatus === "approved").length },
      actor,
      createdAt: Date.now(),
    });
  return { zip: buildZip(files), names };
}
