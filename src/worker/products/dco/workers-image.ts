import { errorMessage } from "../../core/env";
import { sniffAsset, type AssetType } from "./assets";
import { FalError } from "./fal";
import type { VisualPlan } from "./visuals";

// Workers AI image edits (FLUX.2 [klein] 4B): one synchronous call with the uploaded product photo as the input
// image, so there is nothing to poll. The multipart fields (prompt, width, height, input_image_0) were checked
// against the live model on 4 Nov 2026. The answer is a base64 image (JPEG in practice), so its real type is
// sniffed, never assumed. Failures reuse the image-service reasons, which carry the planner-facing text.
const TIMEOUT_MS = 60_000;
type Runner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

export async function editWithWorkersAi(env: Env, plan: VisualPlan, input: { bytes: Uint8Array; contentType: string }): Promise<{ bytes: Uint8Array; type: AssetType }> {
  if (!env.AI) throw new FalError("not_configured");
  const [width, height] = plan.canvas ?? [1024, 1024];
  const form = new FormData();
  form.append("prompt", plan.prompt);
  form.append("width", String(width));
  form.append("height", String(height));
  form.append("input_image_0", new Blob([input.bytes], { type: input.contentType }), "product");
  const multipart = new Response(form);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FalError("submit_failed", `no answer within ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  let out: unknown;
  try {
    out = await Promise.race([
      (env.AI as unknown as Runner).run(plan.modelId, { multipart: { body: multipart.body, contentType: multipart.headers.get("content-type") } }),
      timeout,
    ]);
  } catch (e) {
    if (e instanceof FalError) throw e;
    throw new FalError("submit_failed", errorMessage(e));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const b64 = (out as { image?: unknown } | null)?.image;
  if (typeof b64 !== "string" || !b64) throw new FalError("result_failed", "no image in the answer");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const type = sniffAsset(bytes);
  if (!type) throw new FalError("not_an_image");
  return { bytes, type };
}
