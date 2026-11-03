import { describe, expect, it } from "vitest";
import { findConflicts, matrixBriefSchema } from "../src/worker/products/matrix/brief";

describe("matrix brief (FR-MX-1)", () => {
  it("requires a category, an objective and at least one platform", () => {
    expect(matrixBriefSchema.safeParse({ productCategory: "beauty", objective: "awareness", platforms: ["tiktok"] }).success).toBe(true);
    expect(matrixBriefSchema.safeParse({ productCategory: "", objective: "awareness", platforms: ["tiktok"] }).success).toBe(false);
    expect(matrixBriefSchema.safeParse({ productCategory: "beauty", objective: "reach", platforms: ["tiktok"] }).success).toBe(false);
    expect(matrixBriefSchema.safeParse({ productCategory: "beauty", objective: "awareness", platforms: [] }).success).toBe(false);
  });

  it("reports creators on both lists, ignoring @ and case (AC-MX-2)", () => {
    expect(findConflicts({ mustInclude: ["@Foodie", "other"], mustExclude: ["foodie", "@x"] })).toEqual(["foodie"]);
    expect(findConflicts({ mustInclude: ["a"], mustExclude: ["b"] })).toEqual([]);
  });
});
