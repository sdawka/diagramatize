import sharp from "sharp";
import type { BBox } from "@diagram/core";

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export async function imageSize(png: Buffer) {
  const m = await sharp(png).metadata();
  return { width: m.width!, height: m.height! };
}

/** Normalized box → clamped pixel box, padded by `pad` × the box's larger side. */
export function toPixelBox(b: BBox, width: number, height: number, pad = 0): PixelBox {
  const p = pad * Math.max(b.w * width, b.h * height);
  const left = Math.max(0, Math.floor(b.x * width - p));
  const top = Math.max(0, Math.floor(b.y * height - p));
  const right = Math.min(width, Math.ceil((b.x + b.w) * width + p));
  const bottom = Math.min(height, Math.ceil((b.y + b.h) * height + p));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export async function crop(png: Buffer, b: BBox, pad = 0.06): Promise<{ png: Buffer; box: PixelBox }> {
  const { width, height } = await imageSize(png);
  const box = toPixelBox(b, width, height, pad);
  return { png: await sharp(png).extract(box).png().toBuffer(), box };
}

/**
 * Make the background transparent by flood-filling from the border with the dominant
 * border color. Flat diagram art sits on a near-uniform background, so this is a cheap,
 * dependency-free alternative to an ML matting model.
 */
export async function removeBackground(png: Buffer, tolerance = 38): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = (i: number) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];

  // Most common (quantized) opaque border color = background.
  const counts = new Map<string, { n: number; c: number[] }>();
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  for (const i of border) {
    const c = px(i);
    if (c[3] < 16) continue;
    const k = c.slice(0, 3).map((v) => v >> 4).join(",");
    const e = counts.get(k) ?? { n: 0, c };
    e.n++;
    counts.set(k, e);
  }
  const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c;
  if (!bg) return png; // already transparent

  const near = (i: number) => {
    const o = i * 4;
    if (data[o + 3] < 16) return true;
    const d = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]);
    return d <= tolerance;
  };
  const seen = new Uint8Array(w * h);
  const stack = border.filter(near);
  for (const i of stack) seen[i] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    data[i * 4 + 3] = 0;
    const x = i % w;
    const y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j >= 0 && !seen[j] && near(j)) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** Trim fully transparent margins. */
export async function trimTransparent(png: Buffer): Promise<Buffer> {
  try {
    return await sharp(png).trim({ threshold: 1 }).png().toBuffer();
  } catch {
    return png; // trim throws on fully uniform images
  }
}
