import { describe, expect, it } from "vitest";
import { allowedFigures } from "../src/worker/core/figures";
import { assertAllowed, allowedModel, auditAllowlist, FAL_ALLOWLIST, type AllowedModel } from "../src/worker/products/dco/allowlist";
import { briefTexts, dcoBriefSchema } from "../src/worker/products/dco/brief";
import { buildCopyPrompt, copyJsonSchema, guardCopyOption } from "../src/worker/products/dco/copy";
import { isFetchableFalUrl, isSameOrigin } from "../src/worker/products/dco/fal";
import { MAX_ASSET_BYTES, mintToken, safeFileName, sniffAsset, TOKEN_RE } from "../src/worker/products/dco/assets";
import { copySheetCsv, csvCell, provenanceCsv } from "../src/worker/products/dco/pack";
import { buildZip, crc32 } from "../src/worker/products/dco/zip";
import { falInput, isSafetyErrorType, isSafetyFlagged, outputImages, outputSeed, planFor, VISUAL_PLAN } from "../src/worker/products/dco/visuals";
import { CLAIM_LEASE_MS, insertStatements, MAX_POLLS, POLL_SECONDS, sendEach, STUCK_MS, USER_FAILURE_TEXTS } from "../src/worker/products/dco/pipeline";
import { dcoVisuals } from "../src/worker/products/dco/schema";
import type { Db } from "../src/worker/core/db/client";

const fake = (over: Partial<AllowedModel>): AllowedModel => ({
  id: "fal-ai/bria/expand",
  role: "layout",
  description: "Extends the canvas to a new aspect ratio",
  docs: "https://fal.ai/models/fal-ai/bria/expand/api",
  verifiedOn: "2026-11-02",
  providerSafetyField: "None documented on this endpoint",
  ...over,
});

// AC-DC-2 and FR-DC-2: the configuration audit
describe("allowlist audit (AC-DC-2, FR-DC-2)", () => {
  it("the shipped allowlist passes the audit", () => {
    const audit = auditAllowlist(FAL_ALLOWLIST);
    expect(audit.ok).toBe(true);
    expect(audit.checked).toBe(FAL_ALLOWLIST.length);
    expect(audit.violations).toEqual([]);
  });

  it("every allowlisted model is a layout or scene model with a documentation link", () => {
    for (const m of FAL_ALLOWLIST) {
      expect(["layout", "scene"]).toContain(m.role);
      expect(m.docs.startsWith("https://fal.ai/")).toBe(true);
    }
  });

  it("fails for face swap, face generation and person synthesis wording", () => {
    const audit = auditAllowlist([fake({ id: "fal-ai/face-swap/v2", role: "scene", description: "Swaps a face" })]);
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((v) => v.reason).join(" ")).toMatch(/face|swap/);
  });

  it("fails for portrait, avatar, headshot and person wording in any entry", () => {
    for (const description of ["Generates a portrait", "Builds an avatar", "Makes a headshot", "Synthesises a person", "Copies a likeness"]) {
      expect(auditAllowlist([fake({ description })]).ok).toBe(false);
    }
  });

  it("does not flag ordinary words that contain blocked letters", () => {
    expect(auditAllowlist([fake({ description: "Replaces the surface behind the product" })]).ok).toBe(true);
  });

  it("fails for a duplicate id and for a path that is not a fal-ai model", () => {
    const dup = auditAllowlist([fake({}), fake({})]);
    expect(dup.violations.some((v) => v.reason === "Listed more than once")).toBe(true);
    const path = auditAllowlist([fake({ id: "openai/images" })]);
    expect(path.ok).toBe(false);
  });

  it("every visual slot uses an allowlisted model, and the plan refuses anything else", () => {
    for (const plan of VISUAL_PLAN) expect(allowedModel(plan.modelId)).not.toBeNull();
    expect(() => assertAllowed("fal-ai/face-swap/v2")).toThrow(/not on the DCO allowlist/);
    expect(() => assertAllowed("fal-ai/bria/expand")).not.toThrow();
  });

  it("visual prompts name no person, creator or face", () => {
    for (const plan of VISUAL_PLAN) expect(plan.prompt).not.toMatch(/person|people|face|portrait|avatar|headshot|creator|model/i);
  });
});

// FR-DC-2 request bodies and AC-DC-1 variant shape
describe("visual plan and provider requests (FR-DC-2, AC-DC-1)", () => {
  it("offers at least four visual slots covering 1:1, 4:5, 9:16 and a scene change", () => {
    expect(VISUAL_PLAN.length).toBeGreaterThanOrEqual(4);
    const formats = new Set(VISUAL_PLAN.map((p) => p.format));
    for (const f of ["1:1", "4:5", "9:16"]) expect(formats.has(f)).toBe(true);
    expect(VISUAL_PLAN.some((p) => p.kind === "scene")).toBe(true);
    expect(new Set(VISUAL_PLAN.map((p) => p.key)).size).toBe(VISUAL_PLAN.length);
  });

  it("layout canvases match their aspect ratio", () => {
    for (const plan of VISUAL_PLAN.filter((p) => p.modelId === "fal-ai/bria/expand")) {
      const [w, h] = plan.canvas!;
      const [a, b] = plan.format.split(":").map(Number) as [number, number];
      expect(w / h).toBeCloseTo(a / b, 6);
    }
  });

  it("expand requests carry only the documented layout fields", () => {
    const body = falInput(planFor("format-4x5")!, "https://example.test/input/x");
    expect(Object.keys(body).sort()).toEqual(["aspect_ratio", "canvas_size", "image_url", "prompt"]);
    expect(body.aspect_ratio).toBe("4:5");
    expect(body.canvas_size).toEqual([1080, 1350]);
  });

  it("background replace and product shot requests use their own documented fields", () => {
    const replace = falInput(planFor("scene-studio")!, "https://example.test/input/x");
    expect(replace.num_images).toBe(1);
    expect(replace.negative_prompt).toBe("people faces hands text logo");
    const shot = falInput(planFor("scene-kitchen")!, "https://example.test/input/x");
    expect(shot.scene_description).toBe(planFor("scene-kitchen")!.prompt);
    expect(shot.num_results).toBe(1);
  });

  it("no request body carries a face, person or identity field", () => {
    for (const plan of VISUAL_PLAN) {
      for (const key of Object.keys(falInput(plan, "https://example.test/input/x"))) {
        expect(key).not.toMatch(/face|person|identity|swap|avatar|portrait|likeness/);
      }
    }
  });
});

// Provider output and safety flags (BR-DC-2)
describe("provider output and safety flags (BR-DC-2)", () => {
  it("reads both the images list and the single image shape", () => {
    expect(outputImages({ images: [{ url: "https://v3.fal.media/a.png", content_type: "image/png" }], seed: 7 })).toEqual([
      { url: "https://v3.fal.media/a.png", contentType: "image/png" },
    ]);
    expect(outputImages({ image: { url: "https://v3.fal.media/b.png" }, seed: 8 })).toEqual([{ url: "https://v3.fal.media/b.png", contentType: null }]);
    expect(outputImages({})).toEqual([]);
    expect(outputImages({ images: [{ width: 10 }] })).toEqual([]);
  });

  it("reads a numeric seed only when one is returned", () => {
    expect(outputSeed({ seed: 42 })).toBe(42);
    expect(outputSeed({ seed: "42" })).toBeNull();
    expect(outputSeed({})).toBeNull();
  });

  it("flags a result when a safety flag is set, and only then", () => {
    expect(isSafetyFlagged({ images: [], has_nsfw_concepts: [true] })).toBe(true);
    expect(isSafetyFlagged({ images: [], has_nsfw_concepts: [false] })).toBe(false);
    expect(isSafetyFlagged({ images: [], nsfw_content_detected: true })).toBe(true);
    expect(isSafetyFlagged({ images: [] })).toBe(false);
  });

  it("recognises safety error types without matching ordinary failures", () => {
    expect(isSafetyErrorType("content_policy_violation")).toBe(true);
    expect(isSafetyErrorType("nsfw_filtered")).toBe(true);
    expect(isSafetyErrorType("internal_server_error")).toBe(false);
    expect(isSafetyErrorType(null)).toBe(false);
  });
});

// FR-DC-1 intake
describe("base asset intake (FR-DC-1)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

  it("accepts PNG, JPEG and WebP by their signatures", () => {
    expect(sniffAsset(png)).toEqual({ contentType: "image/png", ext: "png" });
    expect(sniffAsset(jpeg)).toEqual({ contentType: "image/jpeg", ext: "jpg" });
    expect(sniffAsset(webp)).toEqual({ contentType: "image/webp", ext: "webp" });
  });

  it("refuses GIF, PDF, plain text and a PNG name on the wrong bytes", () => {
    expect(sniffAsset(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffAsset(new TextEncoder().encode("%PDF-1.7 ....."))).toBeNull();
    expect(sniffAsset(new TextEncoder().encode("PNG is just text here"))).toBeNull();
    expect(sniffAsset(new Uint8Array())).toBeNull();
  });

  it("caps uploads at 8 MiB", () => {
    expect(MAX_ASSET_BYTES).toBe(8 * 1024 * 1024);
  });

  it("keeps plain filename characters only and drops directories", () => {
    expect(safeFileName("../../secret/brand shot (final).png")).toBe("brand shot _final_.png");
    expect(safeFileName("")).toBe("base-asset");
  });

  it("mints 256-bit hex tokens that differ on every call", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(TOKEN_RE);
    expect(a).not.toBe(b);
    expect(TOKEN_RE.test("short")).toBe(false);
  });

  it("only hands fal https links, or http to localhost", () => {
    expect(isFetchableFalUrl("https://v3b.fal.media/files/x.png")).toBe(true);
    expect(isFetchableFalUrl("http://127.0.0.1:5292/files/x.png")).toBe(true);
    expect(isFetchableFalUrl("http://example.com/x.png")).toBe(false);
    expect(isFetchableFalUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableFalUrl("not a url")).toBe(false);
  });

  it("checks that a status or result URL shares the queue origin", () => {
    expect(isSameOrigin("https://queue.fal.run", "https://queue.fal.run/fal-ai/bria/requests/1/status")).toBe(true);
    expect(isSameOrigin("https://queue.fal.run", "https://evil.example/status")).toBe(false);
    expect(isSameOrigin("https://queue.fal.run", "::bad::")).toBe(false);
  });
});

// Brief inputs (FR-DC-3)
describe("brief (FR-DC-3)", () => {
  const base = { brand: "Example Brand", product: "Crispy snack", segments: [{ name: "Office workers" }] };

  it("defaults to three copy options per segment and no prohibited claims", () => {
    const parsed = dcoBriefSchema.parse(base);
    expect(parsed.copyPerSegment).toBe(3);
    expect(parsed.prohibitedClaims).toEqual([]);
  });

  it("refuses no segments, more than four, out-of-range copy counts and a blank brand", () => {
    expect(dcoBriefSchema.safeParse({ ...base, segments: [] }).success).toBe(false);
    expect(dcoBriefSchema.safeParse({ ...base, segments: [1, 2, 3, 4, 5].map((i) => ({ name: `S${i}` })) }).success).toBe(false);
    expect(dcoBriefSchema.safeParse({ ...base, copyPerSegment: 0 }).success).toBe(false);
    expect(dcoBriefSchema.safeParse({ ...base, copyPerSegment: 6 }).success).toBe(false);
    expect(dcoBriefSchema.safeParse({ ...base, brand: "   " }).success).toBe(false);
  });

  it("includes the offer in the text that figures may repeat", () => {
    const parsed = dcoBriefSchema.parse({ ...base, offer: "20% off on the 500 baht pack" });
    expect(allowedFigures([], briefTexts(parsed))).toEqual(expect.arrayContaining([20, 500]));
  });
});

// Copy guards (FR-DC-3, HR-3)
describe("copy guards (FR-DC-3, HR-3)", () => {
  it("replaces an invented percentage with TBC and says so", () => {
    const out = guardCopyOption({ headline: "Save 50% today", hookLine: "Crunch", caption: "A snack", cta: "Shop now" }, [], []);
    expect(out.option.headline).toBe("Save TBC today");
    expect(out.flags).toContain("figures_replaced:1");
  });

  it("keeps a figure the brief supplies", () => {
    const allowed = allowedFigures([], ["20% off on the 500 baht pack"]);
    const out = guardCopyOption({ headline: "20% off this week", hookLine: "Crunch", caption: "The 500 baht pack", cta: "Shop now" }, allowed, []);
    expect(out.option.headline).toBe("20% off this week");
    expect(out.option.caption).toBe("The 500 baht pack");
    expect(out.flags).toEqual([]);
  });

  it("replaces invented money and template placeholders with TBC", () => {
    const allowed = allowedFigures([], ["no prices in this brief"]);
    const out = guardCopyOption({ headline: "Only ฿299", hookLine: "Try [offer] now", caption: "Use {code} at <checkout>", cta: "Buy" }, allowed, []);
    expect(out.option.headline).toBe("Only TBC");
    expect(out.option.hookLine).toBe("Try TBC now");
    expect(out.option.caption).toBe("Use TBC at TBC");
    expect(out.flags).toEqual(expect.arrayContaining(["figures_replaced:1", "placeholder_replaced:3"]));
  });

  it("flags superlatives and prohibited topics without rewriting the words", () => {
    const out = guardCopyOption({ headline: "The best snack", hookLine: "Cures acne fast", caption: "Tasty", cta: "Buy" }, [], ["cures acne"]);
    expect(out.option.hookLine).toBe("Cures acne fast");
    expect(out.flags).toEqual(expect.arrayContaining(["superlatives", "avoid:cures acne"]));
  });

  it("writes the copy prompt from the brief only, and says so when the offer is missing", () => {
    const brief = dcoBriefSchema.parse({ brand: "B", product: "P", segments: [{ name: "Students", note: "Late nights" }], prohibitedClaims: ["guaranteed"] });
    const prompt = buildCopyPrompt(brief, { name: "Students", note: "Late nights" }, 3);
    expect(prompt.user).toContain("Offer: None given.");
    expect(prompt.user).toContain("Topics to avoid: guaranteed");
    expect(prompt.user).toContain("Number of options: 3");
    expect(prompt.system).toContain("TBC");
  });

  it("asks the model for one to five options in a strict schema", () => {
    const schema = copyJsonSchema().schema as { properties: { options: { minItems?: number; maxItems?: number } } };
    expect(schema.properties.options.minItems).toBe(1);
    expect(schema.properties.options.maxItems).toBe(5);
  });
});

// FR-DC-5: the export pack
type Entry = { name: string; crc: number; size: number; data: string; computed: number };

// Reads a store-only ZIP back the way a reader does: end record, then central directory, then local headers
function readZip(zip: Uint8Array): Entry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let k = 0; k < count; k++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true);
    const data = zip.subarray(start, start + size);
    out.push({ name, crc, size, data: new TextDecoder().decode(data), computed: crc32(data) });
    p += 46 + nameLen;
  }
  return out;
}

describe("store-only ZIP and CSV export (FR-DC-4, FR-DC-5)", () => {
  it("matches the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes entries that read back with their names, sizes and checksums", () => {
    const files = [
      { name: "copy-sheet.csv", data: new TextEncoder().encode("Segment,Headline\r\nStudents,Hello\r\n") },
      { name: "visuals/format-1x1.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) },
      { name: "provenance.csv", data: new TextEncoder().encode("") },
    ];
    const entries = readZip(buildZip(files));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, entry] of entries.entries()) {
      expect(entry.size).toBe(files[i]!.data.length);
      expect(entry.crc).toBe(entry.computed);
    }
    expect(entries[0]!.data).toContain("Students,Hello");
  });

  it("quotes delimiters and neutralises spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", now')).toBe('"say ""hi"", now"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("-20 off")).toBe("'-20 off");
    expect(csvCell(null)).toBe("");
  });

  it("the copy sheet holds approved copy only", () => {
    const detail = {
      id: "run-1",
      segments: [{ key: "s1", name: "Students" }],
      copy: [
        { id: "c1", segmentKey: "s1", position: 1, headline: "Approved line", hookLine: "h", caption: "c", cta: "Buy", flags: [], model: "m", reviewStatus: "approved", createdAt: 0 },
        { id: "c2", segmentKey: "s1", position: 2, headline: "Draft line", hookLine: "h", caption: "c", cta: "Buy", flags: ["superlatives"], model: "m", reviewStatus: "draft", createdAt: 0 },
      ],
      visuals: [],
    } as unknown as Parameters<typeof copySheetCsv>[0];
    const sheet = copySheetCsv(detail);
    expect(sheet).toContain("Approved line");
    expect(sheet).not.toContain("Draft line");
    expect(sheet.split("\r\n")[0]).toContain("Segment,Option,Headline");
  });

  it("the provenance sheet lists every visual and copy option with its job id", () => {
    const detail = {
      id: "run-9",
      segments: [{ key: "s1", name: "Students" }],
      copy: [{ id: "c1", segmentKey: "s1", position: 1, headline: "H", hookLine: "h", caption: "c", cta: "Buy", flags: [], model: "claude", promptVersion: "dco-copy-v1", reviewStatus: "draft", reviewedBy: null, reviewedAt: null, createdAt: 1700000000000 }],
      visuals: [
        {
          key: "format-1x1",
          segmentKey: "s1",
          kind: "format",
          format: "1:1",
          modelId: "fal-ai/bria/expand",
          status: "ready",
          reviewStatus: "approved",
          reviewedBy: "me",
          reviewedAt: 1700000000000,
          error: null,
          provenance: {
            prompt: "soft neutral studio backdrop",
            negativePrompt: null,
            seed: null,
            falRequestId: "req-1",
            inputSha256: "aa",
            outputSha256: "bb",
            outputBytes: 10,
            submittedAt: 1700000000000,
            completedAt: 1700000001000,
            promptVersion: "dco-visual-v1",
          },
        },
      ],
    } as unknown as Parameters<typeof provenanceCsv>[0];
    const sheet = provenanceCsv(detail);
    const lines = sheet.trim().split("\r\n");
    expect(lines[0]).toContain("Fal request id");
    expect(lines.some((l) => l.startsWith("visual,format-1x1,Students,format,1:1,fal-ai/bria/expand"))).toBe(true);
    expect(lines.some((l) => l.startsWith("copy,c1,Students,copy option"))).toBe(true);
    expect(sheet).toContain("run-9");
    expect(sheet).toContain("not returned by the model");
  });
});

// The timing rules and the pure parts of queueing and failure handling for stuck or unsent slots
describe("failure handling for stuck and unsent slots", () => {
  it("a claim outlasts the slowest normal step, and the sweep waits longer than a claim lease", () => {
    expect(CLAIM_LEASE_MS).toBeGreaterThan(MAX_POLLS * POLL_SECONDS * 1000);
    expect(STUCK_MS).toBeGreaterThan(CLAIM_LEASE_MS);
  });

  it("sends every message and reports only the ones whose send threw", async () => {
    const sent: string[] = [];
    const unsent = await sendEach(["copy s1", "visual format-1x1", "copy s2"], async (item) => {
      if (item === "visual format-1x1") throw new Error("queue unavailable");
      sent.push(item);
    });
    expect(sent).toEqual(["copy s1", "copy s2"]);
    expect(unsent).toEqual([{ item: "visual format-1x1", error: "queue unavailable" }]);
  });

  it("splits a bulk insert so no statement binds more than 100 parameters", () => {
    const row = (i: number) => ({
      id: `v${i}`,
      runId: "run",
      planKey: `p${i}`,
      position: i,
      kind: "format" as const,
      label: "Square",
      segmentKey: "s1",
      format: "1:1",
      modelId: "fal-ai/bria/expand",
      status: "pending" as const,
      attempts: 0,
      error: null,
      falRequestId: null,
      statusUrl: null,
      responseUrl: null,
      submittedAt: null,
      r2Key: null,
      contentType: null,
      bytes: null,
      provenance: null,
      reviewStatus: "draft" as const,
      reviewedBy: null,
      reviewedAt: null,
      updatedAt: 0,
    });
    // A stand-in for the drizzle handle: it only records what each insert would bind
    const fakeDb = { insert: (table: unknown) => ({ values: (rows: unknown[]) => ({ table, rows }) }) } as unknown as Db;
    const rows = [0, 1, 2, 3, 4].map(row);
    const statements = insertStatements(fakeDb, dcoVisuals, rows) as unknown as { rows: unknown[] }[];
    const columns = Object.keys(rows[0]!).length;
    expect(columns).toBe(24);
    expect(statements.map((s) => s.rows.length)).toEqual([4, 1]);
    expect(statements.every((s) => s.rows.length * columns <= 100)).toBe(true);
    expect(insertStatements(fakeDb, dcoVisuals, [])).toEqual([]);
  });

  it("every failure text a signed-in user can see is one plain sentence with no raw detail", () => {
    for (const text of USER_FAILURE_TEXTS) {
      expect(text).toMatch(/^[A-Z][^:{}<>"]*\.$/);
      expect(text).not.toMatch(/Error|undefined|null|[–—]/u);
    }
  });
});
