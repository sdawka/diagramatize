import type { AspectRatio } from "@diagram/core";
export interface ImageRequest {
  prompt: string;
  model: string;
  n?: number;
  aspectRatio?: AspectRatio;
  background?: "transparent" | "opaque" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  /** PNG reference images (for editing / style consistency). */
  references?: Buffer[];
  outputFormat?: "png" | "svg" | "webp";
  /** Candidate / component id recorded with the usage event. */
  ref?: string;
  /** Structured context only the mock provider reads. */
  context?: unknown;
}

export interface ImageOut {
  data: Buffer;
  mediaType: string;
  /** Latency of the call that produced this image (set by the provider when known). */
  ms?: number;
  /** USD cost attributed to this image; null/undefined when the provider doesn't report it. */
  cost?: number | null;
  /** Outputs sharing a call id came from one provider request (e.g. a layer split). */
  call?: number;
}

export type ImageProvider = (req: ImageRequest) => Promise<ImageOut[]>;

/** Run `n` single-image requests in parallel; not every model supports n>1. */
export async function fanOut(n: number, one: () => Promise<ImageOut[]>): Promise<ImageOut[]> {
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, call) => one().then((outs) => outs.map((o) => ({ ...o, call })))),
  );
  const ok = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  if (!ok.length) {
    const err = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    throw err?.reason ?? new Error("all image requests failed");
  }
  return ok;
}
