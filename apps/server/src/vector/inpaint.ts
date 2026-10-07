import sharp from "sharp";
import type { BBox } from "@diagram/core";

/** Backends that fill masked pixels of an RGBA image. A learned model (e.g. LaMa) can be registered here. */
export type InpaintMethod = "diffusion";

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

type Backend = (img: RawImage, mask: Uint8Array) => void;

const backends: Record<InpaintMethod, Backend> = { diffusion: diffuse };

/**
 * Fill the masked pixels (mask[i] != 0) of a PNG from their surroundings. Where the surroundings
 * are transparent the hole becomes transparent; where they are opaque it takes their colour.
 */
export async function inpaint(png: Buffer, mask: Uint8Array, method: InpaintMethod = "diffusion"): Promise<Buffer> {
  const img = await decodeRaw(png);
  if (mask.length !== img.width * img.height) throw new Error("mask size does not match the image");
  backends[method](img, mask);
  return encodeRaw(img);
}

export async function decodeRaw(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export const encodeRaw = (img: RawImage) =>
  sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();

const ALPHA_SOLID = 128;
const SOLID_MIN = 32;

/**
 * Onion-peel the hole from its known rim (each ring takes the mean of already-known neighbours),
 * then relax with Gauss-Seidel sweeps so the fill is smooth. Colour and alpha are filled together
 * in premultiplied space; alpha is snapped to 0/255 at the end, so a hole on an edge keeps the edge.
 */
function diffuse(img: RawImage, mask: Uint8Array): void {
  const { data, width: w, height: h } = img;
  const n = w * h;
  // premultiplied float channels
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    ch[0][i] = (data[i * 4] / 255) * a;
    ch[1][i] = (data[i * 4 + 1] / 255) * a;
    ch[2][i] = (data[i * 4 + 2] / 255) * a;
    ch[3][i] = a;
  }
  const known = new Uint8Array(n);
  const holes: number[] = [];
  for (let i = 0; i < n; i++) (mask[i] ? holes.push(i) : (known[i] = 1));
  if (!holes.length) return;
  const neighbours = (i: number) => {
    const x = i % w;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (i >= w) out.push(i - w);
    if (i < n - w) out.push(i + w);
    return out;
  };
  // Peel: process holes ring by ring.
  let pending = holes;
  const order: number[] = [];
  while (pending.length) {
    const next: number[] = [];
    const filled: number[] = [];
    for (const i of pending) {
      const ks = neighbours(i).filter((j) => known[j]);
      if (!ks.length) {
        next.push(i);
        continue;
      }
      for (const c of ch) c[i] = ks.reduce((s, j) => s + c[j], 0) / ks.length;
      filled.push(i);
    }
    if (!filled.length) break; // hole with no known pixel at all: leave as is
    for (const i of filled) known[i] = 1;
    order.push(...filled);
    pending = next;
  }
  // Relax.
  for (let it = 0; it < 60; it++) {
    for (const i of order) {
      const ns = neighbours(i);
      for (const c of ch) c[i] = ns.reduce((s, j) => s + c[j], 0) / ns.length;
    }
  }
  for (const i of order) {
    const a = ch[3][i];
    if (a < 0.5) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 0;
      continue;
    }
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.max(0, Math.min(255, Math.round((ch[k][i] / a) * 255)));
    data[i * 4 + 3] = 255;
  }
}

// ---------- text stripping ----------

export interface StripBox {
  bbox: BBox;
  /** Hex colour of the lettering. */
  color: string;
}

const COLOR_TOLERANCE = 110;
const DILATE = 2;

const hex = (c: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const v = m ? parseInt(m[1], 16) : 0x222222;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/**
 * Mask the lettering of `boxes` in a layer: opaque, text-coloured pixels inside a box (grown a few
 * px) that form small connected components lying entirely within it. A shape that merely passes
 * under a box reaches beyond it and is left alone. `layerBox` is the layer's frame box, so boxes
 * can be given in frame coordinates.
 */
export function textMask(img: RawImage, layerBox: BBox, frame: { width: number; height: number }, boxes: StripBox[]): Uint8Array {
  const { data, width: w, height: h } = img;
  const mask = new Uint8Array(w * h);
  const ox = layerBox.x * frame.width, oy = layerBox.y * frame.height;
  for (const b of boxes) {
    const bx0 = Math.max(0, Math.floor(b.bbox.x * frame.width - ox) - DILATE), by0 = Math.max(0, Math.floor(b.bbox.y * frame.height - oy) - DILATE);
    const bx1 = Math.min(w - 1, Math.ceil((b.bbox.x + b.bbox.w) * frame.width - ox) + DILATE);
    const by1 = Math.min(h - 1, Math.ceil((b.bbox.y + b.bbox.h) * frame.height - oy) + DILATE);
    if (bx1 < bx0 || by1 < by0) continue;
    const [tr, tg, tb] = hex(b.color);
    const cand = new Uint8Array(w * h);
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < ALPHA_SOLID) continue;
        if (Math.hypot(data[i] - tr, data[i + 1] - tg, data[i + 2] - tb) <= COLOR_TOLERANCE) cand[y * w + x] = 1;
      }
    // Connected components of candidates; keep those wholly inside the box (no candidate on the box edge
    // that continues outside it).
    const seen = new Uint8Array(w * h);
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const s = y * w + x;
        if (!cand[s] || seen[s]) continue;
        const comp: number[] = [s];
        seen[s] = 1;
        let escapes = false;
        for (let k = 0; k < comp.length; k++) {
          const i = comp[k];
          const cx = i % w, cy = (i / w) | 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) {
                // Outside the box: a text-coloured neighbour means the component continues beyond it.
                const q = j * 4;
                if (data[q + 3] >= ALPHA_SOLID && Math.hypot(data[q] - tr, data[q + 1] - tg, data[q + 2] - tb) <= COLOR_TOLERANCE) escapes = true;
                continue;
              }
              if (cand[j] && !seen[j]) {
                seen[j] = 1;
                comp.push(j);
              }
            }
        }
        if (escapes) continue;
        // Reject components that are most of the box (a filled shape of the text colour).
        if (comp.length > 0.6 * (bx1 - bx0 + 1) * (by1 - by0 + 1)) continue;
        for (const i of comp) mask[i] = 1;
      }
  }
  // Grow by the anti-aliasing fringe, but only onto pixels not exactly flat-opaque far from text colour.
  return grow(mask, w, h, 2);
}

function grow(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!cur[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) next[ny * w + nx] = 1;
          }
      }
    cur = next;
  }
  return cur;
}

/** Remove lettering from a layer and fill the holes. Returns the number of pixels removed. */
export async function stripText(
  png: Buffer,
  layerBox: BBox,
  frame: { width: number; height: number },
  boxes: StripBox[],
  method: InpaintMethod = "diffusion",
): Promise<{ png: Buffer; removed: number }> {
  const img = await decodeRaw(png);
  const mask = textMask(img, layerBox, frame, boxes);
  let removed = 0;
  // Only holes that were opaque matter; transparent pixels need no fill.
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && img.data[i * 4 + 3] < SOLID_MIN) mask[i] = 0;
    else if (mask[i]) removed++;
  }
  if (!removed) return { png, removed: 0 };
  backends[method](img, mask);
  return { png: await encodeRaw(img), removed };
}
