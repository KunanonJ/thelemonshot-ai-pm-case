import { describe, expect, it } from "vitest";
import { parseJsonObject } from "../src/worker/core/llm";
import { sanitiseCaption, splitForContext, validateScores, type LlmCandidate } from "../src/worker/products/matrix/contract";

describe("caption sanitising (FR-CORE-17)", () => {
  it("strips emails, links and phone numbers", () => {
    const out = sanitiseCaption("ติดต่อ work@brand.co.th หรือ 081-234-5678 ดูที่ https://shop.example/x ด้วยนะ");
    expect(out).not.toMatch(/@brand|081|https/);
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).toContain("[link]");
  });
});

describe("score validation (FR-MX-5)", () => {
  const row = (creatorId: string, rationale = "ER 6.1% is 1.5x the tier median") => ({ creatorId, audienceFit: 80.4, brandSafety: 90, creativeFit: 70, rationale });

  it("ignores unknown IDs, keeps the first duplicate and lists missing creators", () => {
    const v = validateScores(["a", "b", "c"], [row("a"), row("a", "second"), row("zzz"), row("b")]);
    expect([...v.dims.keys()]).toEqual(["a", "b"]);
    expect(v.rationales.get("a")).toContain("ER 6.1%");
    expect(v.missing).toEqual(["c"]);
    expect(v.dims.get("a")!.audienceFit).toBe(80);
  });

  it("flags a rationale that cites no concrete fact", () => {
    const v = validateScores(["a"], [row("a", "Great vibes and a lovely creator overall")]);
    expect(v.flags.get("a")).toEqual(["rationale_unverified"]);
  });
});

describe("payload split (BR-MX-1)", () => {
  const candidate = (i: number): LlmCandidate => ({ id: `c${i}`, name: "x".repeat(200), categories: [], platforms: [], topHashtags: [], recentCaptions: [] });

  it("keeps small payloads in one call and halves large ones", () => {
    expect(splitForContext([candidate(1), candidate(2)])).toHaveLength(1);
    const parts = splitForContext([candidate(1), candidate(2), candidate(3)], 100);
    expect(parts).toHaveLength(2);
    expect(parts.flat()).toHaveLength(3);
  });
});

describe("JSON parsing", () => {
  it("accepts fenced JSON and rejects prose", () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonObject("Sure! Here you go")).toBeNull();
  });
});
