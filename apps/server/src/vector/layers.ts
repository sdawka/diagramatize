import sharp from "sharp";
import type { BBox, DecomposedComponent } from "@diagram/core";

/**
 * Regroup model-split RGBA layers into per-component icons.
 *
 * Layer models (e.g. Ming design-layer) split a flat design by visual *type*: all labels
 * in one layer, all arrows in another, every inner detail in a third, outer shapes one per
 * layer, plus a background. We break each layer into connected blobs and assign each blob to
 * the component whose (vision-model) box contains it, skipping text, connectors and
 * background. Compositing a component's blobs gives a clean, already-transparent icon.
 */

interface Layer {
  data: Buffer;
  width: number;
  height: number;
}

interface Blob {
  layer: number;
  pixels: Uint32Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const ALPHA_MIN = 32;
const MIN_BLOB_PX = 12;
const BACKGROUND_COVERAGE = 0.6;

async function decode(png: Buffer): Promise<Layer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function blobs(layer: Layer, index: number): Blob[] {
  const { data, width: w, height: h } = layer;
  const n = w * h;
  let opaque = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > ALPHA_MIN) opaque++;
  if (opaque / n > BACKGROUND_COVERAGE) return []; // background layer

  const seen = new Uint8Array(n);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start * 4 + 3] <= ALPHA_MIN) continue;
    const px: number[] = [];
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      px.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!seen[j] && data[j * 4 + 3] > ALPHA_MIN) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    if (px.length >= MIN_BLOB_PX) out.push({ layer: index, pixels: Uint32Array.from(px), x0, y0, x1, y1 });
  }
  return out;
}

const area = (b: { x0: number; y0: number; x1: number; y1: number }) => Math.max(0, b.x1 - b.x0 + 1) * Math.max(0, b.y1 - b.y0 + 1);

function pxBox(b: BBox, w: number, h: number, grow: number) {
  const gx = b.w * w * grow;
  const gy = b.h * h * grow;
  return { x0: b.x * w - gx, y0: b.y * h - gy, x1: (b.x + b.w) * w + gx, y1: (b.y + b.h) * h + gy };
}

function overlap(a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) {
  return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
}

export interface IsolatedComponent {
  png: Buffer;
  bbox: BBox;
}

/** @param layerPngs layers top-most first (as returned by the layer model). */
export async function isolateComponents(
  layerPngs: Buffer[],
  comps: DecomposedComponent[],
): Promise<Map<string, IsolatedComponent>> {
  const layers = await Promise.all(layerPngs.map(decode));
  const { width: W, height: H } = layers[0];
  const sameSize = layers.filter((l) => l.width === W && l.height === H);
  const allBlobs = sameSize.flatMap((l, i) => blobs(l, i));

  const boxes = comps.map((c) => ({ c, box: pxBox(c.bbox, W, H, 0.08), label: c.labelBox ? pxBox(c.labelBox, W, H, 0.1) : null }));
  const assigned = new Map<string, Blob[]>();
  for (const b of allBlobs) {
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const inside = (r: { x0: number; y0: number; x1: number; y1: number }) => cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
    // Label text → dropped (labels are re-added as native SVG text).
    if (boxes.some((x) => x.label && inside(x.label) && !inside(x.box))) continue;
    const owners = boxes
      .filter((x) => inside(x.box) && overlap(b, x.box) >= 0.6 * area(b))
      .sort((p, q) => area(p.box) - area(q.box)); // most specific box wins (icons over containers)
    if (!owners.length) continue; // connectors and strays
    const id = owners[0].c.id;
    assigned.set(id, [...(assigned.get(id) ?? []), b]);
  }

  const out = new Map<string, IsolatedComponent>();
  for (const [id, bs] of assigned) {
    const x0 = Math.max(0, Math.min(...bs.map((b) => b.x0)) - 4);
    const y0 = Math.max(0, Math.min(...bs.map((b) => b.y0)) - 4);
    const x1 = Math.min(W - 1, Math.max(...bs.map((b) => b.x1)) + 4);
    const y1 = Math.min(H - 1, Math.max(...bs.map((b) => b.y1)) + 4);
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const buf = Buffer.alloc(cw * ch * 4);
    // Paint bottom layers first so upper layers land on top.
    for (const b of [...bs].sort((p, q) => q.layer - p.layer)) {
      const src = sameSize[b.layer].data;
      for (const i of b.pixels) {
        const sx = i % W;
        const sy = (i / W) | 0;
        const o = ((sy - y0) * cw + (sx - x0)) * 4;
        const a = src[i * 4 + 3] / 255;
        const da = buf[o + 3] / 255;
        const outA = a + da * (1 - a);
        for (let k = 0; k < 3; k++) {
          buf[o + k] = outA ? Math.round((src[i * 4 + k] * a + buf[o + k] * da * (1 - a)) / outA) : 0;
        }
        buf[o + 3] = Math.round(outA * 255);
      }
    }
    out.set(id, {
      png: await sharp(buf, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer(),
      bbox: { x: x0 / W, y: y0 / H, w: cw / W, h: ch / H },
    });
  }
  return out;
}

// ---------- whole layers (no decomposition) ----------

export interface TrimmedLayer {
  index: number;
  /** Layer pixels cropped to their opaque extent (transparent elsewhere). */
  png: Buffer;
  bbox: BBox;
  /** Share of the frame that is opaque. */
  coverage: number;
  /** Pixel size of the untrimmed layer. */
  frame: { width: number; height: number };
}

/** Crop each layer to its opaque pixels; empty layers are dropped. */
export async function trimLayers(layerPngs: Buffer[]): Promise<TrimmedLayer[]> {
  const out: TrimmedLayer[] = [];
  for (const [index, png] of layerPngs.entries()) {
    const { data, width: w, height: h } = await decode(png);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, opaque = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Same cut-off the tracer uses, so faint residue doesn't widen the box and shift the trace.
        if (data[(y * w + x) * 4 + 3] < 128) continue;
        opaque++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (opaque < MIN_BLOB_PX) continue;
    x0 = Math.max(0, x0 - 2);
    y0 = Math.max(0, y0 - 2);
    x1 = Math.min(w - 1, x1 + 2);
    y1 = Math.min(h - 1, y1 + 2);
    out.push({
      index,
      png: await sharp(png).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer(),
      bbox: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h },
      coverage: opaque / (w * h),
      frame: { width: w, height: h },
    });
  }
  return out;
}

/** Numbered thumbnails of the layers on a checkerboard, so a vision model can name them. */
export async function layerSheet(layers: TrimmedLayer[], full: { width: number; height: number }): Promise<Buffer> {
  const cols = 3;
  const tw = 420;
  const th = Math.round((tw * full.height) / full.width);
  const rows = Math.ceil(layers.length / cols);
  const pad = 36;
  const W = cols * tw;
  const H = rows * (th + pad);
  const checker = `<pattern id="c" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#e9e9e9"/><rect width="8" height="8" fill="#d0d0d0"/><rect x="8" y="8" width="8" height="8" fill="#d0d0d0"/></pattern>`;
  const cells = layers
    .map((l, i) => {
      const x = (i % cols) * tw;
      const y = Math.floor(i / cols) * (th + pad);
      return `<rect x="${x + 2}" y="${y + pad}" width="${tw - 4}" height="${th - 4}" fill="url(#c)"/><text x="${x + 8}" y="${y + 26}" font-family="Helvetica, Arial" font-size="24" font-weight="700" fill="#111">Layer ${l.index}</text>`;
    })
    .join("");
  const base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${checker}</defs><rect width="100%" height="100%" fill="#fff"/>${cells}</svg>`))
    .png()
    .toBuffer();
  const tiles = await Promise.all(
    layers.map(async (l, i) => {
      // Place each trimmed layer where it sits in the frame, scaled to the tile.
      const left = Math.round((i % cols) * tw + 2 + l.bbox.x * (tw - 4));
      const top = Math.round(Math.floor(i / cols) * (th + pad) + pad + l.bbox.y * (th - 4));
      const w = Math.max(1, Math.round(l.bbox.w * (tw - 4)));
      const h = Math.max(1, Math.round(l.bbox.h * (th - 4)));
      return { input: await sharp(l.png).resize(w, h, { fit: "fill" }).png().toBuffer(), left, top };
    }),
  );
  return sharp(base).composite(tiles).png().toBuffer();
}

/** Tighten model-estimated text boxes to the opaque pixels of the text layer(s) they cover. */
export async function snapTextBoxes<T extends { bbox: BBox }>(textLayerPngs: Buffer[], texts: T[]): Promise<T[]> {
  if (!textLayerPngs.length) return texts;
  const layers = await Promise.all(textLayerPngs.map(decode));
  const { width: W, height: H } = layers[0];
  return texts.map((t) => {
    const r = pxBox(t.bbox, W, H, 0.15);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const l of layers) {
      if (l.width !== W || l.height !== H) continue;
      for (let y = Math.max(0, Math.floor(r.y0)); y <= Math.min(H - 1, Math.ceil(r.y1)); y++) {
        for (let x = Math.max(0, Math.floor(r.x0)); x <= Math.min(W - 1, Math.ceil(r.x1)); x++) {
          if (l.data[(y * W + x) * 4 + 3] <= ALPHA_MIN) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return t;
    const snapped = { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
    // Neighbouring text inside the grown box can inflate the snap; only accept a plausible tightening.
    const ok = snapped.w <= t.bbox.w * 1.35 && snapped.h <= t.bbox.h * 1.35;
    return ok ? { ...t, bbox: snapped } : t;
  });
}

export interface BoundedObject {
  /** The object's own pixels (anti-aliased edges included), transparent elsewhere. */
  png: Buffer;
  /** Box in the full frame, normalized. */
  bbox: BBox;
}

/** Above this many separate objects a layer is texture (dots, hatching): keep it whole. */
const MAX_OBJECTS = 12;

/**
 * Split one trimmed layer into separately bounded objects: solid pixels are grouped into connected
 * blobs, blobs closer than a gap are merged (an icon's parts, a dashed line, a scatter cloud), and
 * each group is cropped to its own extent with its soft edge pixels.
 */
export async function boundObjects(layer: TrimmedLayer): Promise<BoundedObject[]> {
  const frame = layer.frame;
  const { data, width: w, height: h } = await decode(layer.png);
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; px: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (label[start] >= 0 || data[start * 4 + 3] < 128) continue;
    const id = boxes.length;
    const b = { x0: w, y0: h, x1: 0, y1: 0, px: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      b.px++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] < 0 && data[j * 4 + 3] >= 128) {
            label[j] = id;
            stack.push(j);
          }
        }
    }
    boxes.push(b);
  }
  if (boxes.length <= 1) return [{ png: layer.png, bbox: layer.bbox }];

  // Merge blobs whose boxes come within `gap` of each other (union-find until stable).
  const gap = Math.max(8, Math.round(0.015 * Math.max(frame.width, frame.height)));
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
    a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
  const groups = () => {
    const g = new Map<number, { x0: number; y0: number; x1: number; y1: number; px: number }>();
    boxes.forEach((b, i) => {
      const r = find(i);
      const cur = g.get(r);
      g.set(r, cur ? { x0: Math.min(cur.x0, b.x0), y0: Math.min(cur.y0, b.y0), x1: Math.max(cur.x1, b.x1), y1: Math.max(cur.y1, b.y1), px: cur.px + b.px } : { ...b });
    });
    return g;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const g = [...groups().entries()];
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        if (find(g[i][0]) !== find(g[j][0]) && near(g[i][1], g[j][1])) {
          parent[find(g[i][0])] = find(g[j][0]);
          changed = true;
        }
      }
  }
  const final = [...groups().entries()].filter(([, b]) => b.px >= MIN_BLOB_PX);
  if (final.length <= 1 || final.length > MAX_OBJECTS) return [{ png: layer.png, bbox: layer.bbox }];

  // Owner of every pixel within 2px of a solid pixel, so soft edges travel with their object.
  const owner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (label[i] >= 0) owner[i] = find(label[i]);
  for (let pass = 0; pass < 2; pass++) {
    const prev = owner.slice();
    for (let i = 0; i < n; i++) {
      if (prev[i] >= 0) continue;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && prev[ny * w + nx] >= 0) {
          owner[i] = prev[ny * w + nx];
          break;
        }
      }
    }
  }

  const fx = layer.bbox.x * frame.width, fy = layer.bbox.y * frame.height;
  const out: BoundedObject[] = [];
  for (const [root, b] of final) {
    const x0 = Math.max(0, b.x0 - 2), y0 = Math.max(0, b.y0 - 2), x1 = Math.min(w - 1, b.x1 + 2), y1 = Math.min(h - 1, b.y1 + 2);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const buf = Buffer.alloc(cw * ch * 4);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (owner[i] !== root) continue;
        data.copy(buf, ((y - y0) * cw + (x - x0)) * 4, i * 4, i * 4 + 4);
      }
    out.push({
      png: await sharp(buf, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer(),
      bbox: { x: (fx + x0) / frame.width, y: (fy + y0) / frame.height, w: cw / frame.width, h: ch / frame.height },
    });
  }
  // Reading order: top-to-bottom, then left-to-right.
  return out.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}
