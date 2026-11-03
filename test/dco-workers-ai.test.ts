import { describe, expect, it, vi } from "vitest";
import { FalError } from "../src/worker/products/dco/fal";
import { planFor } from "../src/worker/products/dco/visuals";
import { editWithWorkersAi } from "../src/worker/products/dco/workers-image";

// A 4-byte JPEG header is enough for the type sniffer; the real model returns a full JPEG as base64
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const product = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), contentType: "image/png" };

function envWith(run?: (model: string, input: Record<string, unknown>) => Promise<unknown>) {
  return (run ? { AI: { run: vi.fn(run) } } : {}) as unknown as Env & { AI: { run: ReturnType<typeof vi.fn> } };
}

describe("Workers AI image edits (FLUX.2 [klein])", () => {
  it("sends the fixed prompt, the slot's size and the product photo as a multipart form", async () => {
    const env = envWith(async () => ({ image: b64(JPEG) }));
    const plan = planFor("format-4x5")!;
    await editWithWorkersAi(env, plan, product);
    const [model, input] = env.AI.run.mock.calls[0]! as [string, { multipart: { body: ReadableStream; contentType: string } }];
    expect(model).toBe("@cf/black-forest-labs/flux-2-klein-4b");
    const form = await new Response(input.multipart.body, { headers: { "content-type": input.multipart.contentType } }).formData();
    expect(form.get("prompt")).toBe(plan.prompt);
    expect([form.get("width"), form.get("height")]).toEqual(["864", "1080"]);
    const image = form.get("input_image_0") as File;
    expect(image.type).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(product.bytes);
    expect([...form.keys()].sort()).toEqual(["height", "input_image_0", "prompt", "width"]);
  });

  it("reads the image type from the bytes, not from what the model claims", async () => {
    const out = await editWithWorkersAi(envWith(async () => ({ image: b64(JPEG) })), planFor("scene-kitchen")!, product);
    expect(out.type).toEqual({ contentType: "image/jpeg", ext: "jpg" });
    expect(out.bytes).toEqual(JPEG);
  });

  it("names each failure with the image-service reasons the planner sees", async () => {
    const plan = planFor("scene-studio")!;
    await expect(editWithWorkersAi(envWith(), plan, product)).rejects.toMatchObject({ reason: "not_configured" });
    await expect(editWithWorkersAi(envWith(async () => { throw new Error("AiError: 3040: capacity"); }), plan, product)).rejects.toMatchObject({ reason: "submit_failed" });
    await expect(editWithWorkersAi(envWith(async () => ({})), plan, product)).rejects.toMatchObject({ reason: "result_failed" });
    await expect(editWithWorkersAi(envWith(async () => ({ image: b64(new Uint8Array([1, 2, 3])) })), plan, product)).rejects.toMatchObject({ reason: "not_an_image" });
    await expect(editWithWorkersAi(envWith(async () => ({})), plan, product)).rejects.toBeInstanceOf(FalError);
  });
});
