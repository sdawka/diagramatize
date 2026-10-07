import sharp from "sharp";
import { alignAxisLines, bridgeGaps, cleanPath, joinCollinearPaths, joinEndpoints, polylineLength, smoothPath, type Pt } from "./snap.js";

/**
 * Centreline tracing for thin-line art (axes, curves, arrows, pipes): colour-separate the ink,
 * thin each colour to a 1px skeleton, walk it into polylines, clean them up (see snap.ts) and emit
 * stroked paths. Thick solid regions are left to the caller (vtracer) and returned as a mask.
 */

export interface CenterlineResult {
  /** `<svg>` body: stroked paths, grouped per colour. */
  body: string;
  width: number;
  height: number;
  /** Ink pixels (RGBA, alpha 255) that are solid blobs rather than lines — trace those with vtracer. */
  blobs: Buffer | null;
  /** Fraction of the ink that is blob (0..1). */
  blobShare: number;
  /** Fraction of the image area that is ink. */
  coverage: number;
  /** Mean stroke width of the traced lines, in px. */
  strokeWidth: number;
  paths: number;
}

/** Bounds on the "solid" radius: ink thicker than ~2× this is a filled shape, not line work. */
const BLOB_MIN = 2.5, BLOB_MAX = 5;

/** Typical line half-width: a low percentile of the distance transform along its ridges. */
function lineHalfWidth(dt: Float32Array, mask: Uint8Array, w: number, h: number) {
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = dt[i];
      if (!mask[i]) continue;
      if (v >= dt[i - 1] && v >= dt[i + 1] && v >= dt[i - w] && v >= dt[i + w]) vals.push(v);
    }
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.25)];
}

// ---------- colour separation ----------

type RGB = [number, number, number];
const d2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** k-means (farthest-point init) on opaque pixels, then merge near-identical centres. */
function inkPalette(rgba: Buffer, n: number, maxK = 5): RGB[] {
  const sample: RGB[] = [];
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) if (rgba[i * 4 + 3] > 0) sample.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  if (!sample.length) return [];
  const centres: RGB[] = [sample[0]];
  while (centres.length < maxK) {
    let best = -1, bd = 0;
    sample.forEach((s, i) => {
      const d = Math.min(...centres.map((c) => d2(s, c)));
      if (d > bd) (bd = d), (best = i);
    });
    if (best < 0 || bd < 40 * 40) break;
    centres.push(sample[best]);
  }
  for (let it = 0; it < 8; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const s of sample) {
      let b = 0, bd = Infinity;
      centres.forEach((c, k) => {
        const d = d2(s, c);
        if (d < bd) (bd = d), (b = k);
      });
      sum[b][0] += s[0], sum[b][1] += s[1], sum[b][2] += s[2], sum[b][3]++;
    }
    sum.forEach((s, k) => s[3] && (centres[k] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
  }
  const out: RGB[] = [];
  for (const c of centres) if (!out.some((o) => d2(o, c) < 45 * 45)) out.push(c);
  return out;
}

const hex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// ---------- distance transform, thinning ----------

/** Two-pass chamfer distance to the nearest zero pixel (inside `mask`) — or, with `invert`, to the nearest set pixel. */
function chamfer(mask: Uint8Array, w: number, h: number, invert = false) {
  const INF = 1e9, D = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = (invert ? mask[i] : !mask[i]) ? 0 : INF;
  // The image border counts as background (a stripe cut by the crop edge is still thin).
  if (!invert)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (d[y * w + x] && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) d[y * w + x] = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  // Border counts as background so strokes touching the edge still thin properly.
  return d;
}

/** Zhang–Suen thinning in place on a (w+2)×(h+2)-padded copy; returns a skeleton of the original size. */
function thin(mask: Uint8Array, w: number, h: number) {
  const W = w + 2, H = h + 2;
  const im = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) im[(y + 1) * W + x + 1] = mask[y * w + x];
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y <= h; y++)
        for (let x = 1; x <= w; x++) {
          const i = y * W + x;
          if (!im[i]) continue;
          const p2 = im[i - W], p3 = im[i - W + 1], p4 = im[i + 1], p5 = im[i + W + 1];
          const p6 = im[i + W], p7 = im[i + W - 1], p8 = im[i - 1], p9 = im[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = +(!p2 && p3) + +(!p3 && p4) + +(!p4 && p5) + +(!p5 && p6) + +(!p6 && p7) + +(!p7 && p8) + +(!p8 && p9) + +(!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      if (del.length) changed = true;
      for (const i of del) im[i] = 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = im[(y + 1) * W + x + 1];
  return out;
}

// ---------- skeleton → polylines ----------

const N8: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

interface RawPath {
  pts: Pt[];
  /** True when that end is a free tip (not a junction), used for spur pruning. */
  tipStart: boolean;
  tipEnd: boolean;
}

function skeletonPaths(sk: Uint8Array, w: number, h: number, pathOf: Int32Array): RawPath[] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? sk[y * w + x] : 0);
  // Crossing number classifies tips (1) and junctions (≥3) robustly against staircase corners.
  const kind = new Uint8Array(w * h); // 0 plain, 1 tip, 2 junction, 3 isolated
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!sk[y * w + x]) continue;
      let cross = 0, cnt = 0;
      for (let k = 0; k < 8; k++) {
        const a = at(x + N8[k][0], y + N8[k][1]), b = at(x + N8[(k + 1) % 8][0], y + N8[(k + 1) % 8][1]);
        if (!a && b) cross++;
        cnt += a;
      }
      kind[y * w + x] = cnt === 0 ? 3 : cross >= 3 ? 2 : cross === 1 ? 1 : 0;
    }
  const seen = new Uint8Array(w * h);
  const out: RawPath[] = [];
  const walk = (sx: number, sy: number, fx: number, fy: number): RawPath => {
    const pts: Pt[] = [{ x: sx + 0.5, y: sy + 0.5 }];
    const pid = out.length;
    pathOf[sy * w + sx] ||= pid + 1;
    let x = fx, y = fy;
    let tipEnd = false;
    for (;;) {
      const i = y * w + x;
      pts.push({ x: x + 0.5, y: y + 0.5 });
      if (kind[i] === 2) break;
      seen[i] = 1;
      pathOf[i] = pid + 1;
      if (kind[i] === 1) {
        tipEnd = true;
        break;
      }
      // Prefer unvisited 4-neighbours so staircases don't cut corners through junction-like pixels.
      let nx = -1, ny = -1, best = 9;
      for (let k = 0; k < 8; k++) {
        const px = x + N8[k][0], py = y + N8[k][1];
        if (!at(px, py) || seen[py * w + px]) continue;
        const pr = k % 2 === 0 ? 0 : 1;
        if (pr < best) (best = pr), (nx = px), (ny = py);
      }
      if (nx < 0) {
        tipEnd = true;
        break;
      }
      x = nx;
      y = ny;
    }
    return { pts, tipStart: kind[sy * w + sx] === 1, tipEnd };
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!sk[i] || kind[i] === 0 || (kind[i] !== 2 && seen[i])) continue;
      if (kind[i] === 3) {
        pathOf[i] = out.length + 1;
        out.push({ pts: [{ x: x + 0.5, y: y + 0.5 }], tipStart: true, tipEnd: true });
        seen[i] = 1;
        continue;
      }
      if (kind[i] === 1) seen[i] = 1;
      for (let k = 0; k < 8; k++) {
        const nx = x + N8[k][0], ny = y + N8[k][1];
        if (!at(nx, ny) || seen[ny * w + nx] || (kind[ny * w + nx] === 2 && kind[i] === 2)) continue;
        out.push(walk(x, y, nx, ny));
      }
    }
  // Closed loops: nothing but plain pixels left.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!sk[i] || seen[i]) continue;
      for (let k = 0; k < 8; k++) {
        const nx = x + N8[k][0], ny = y + N8[k][1];
        if (at(nx, ny) && !seen[ny * w + nx]) {
          seen[i] = 1;
          const p = walk(x, y, nx, ny);
          const a = p.pts[0], z = p.pts[p.pts.length - 1];
          if (Math.hypot(a.x - z.x, a.y - z.y) < 2.5) p.pts.push(a);
          out.push(p);
          break;
        }
      }
    }
  return out;
}

/** Label every mask pixel with the path whose skeleton is geodesically nearest (multi-source BFS). */
function assignArea(mask: Uint8Array, pathOf: Int32Array, w: number, h: number, n: number) {
  const area = new Float64Array(n + 1);
  const label = new Int32Array(w * h);
  let q: number[] = [];
  for (let i = 0; i < w * h; i++) if (pathOf[i]) (label[i] = pathOf[i]), q.push(i);
  while (q.length) {
    const next: number[] = [];
    for (const i of q) {
      const x = i % w, y = (i / w) | 0;
      for (let k = 0; k < 8; k += 2) {
        const nx = x + N8[k][0], ny = y + N8[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !label[j]) (label[j] = label[i]), next.push(j);
      }
    }
    q = next;
  }
  for (let i = 0; i < w * h; i++) if (mask[i] && label[i]) area[label[i]]++;
  return area;
}

/**
 * Thinning lands on a pixel row, which is up to half a pixel off the true middle of an even-width
 * stroke. Slide each point along its normal to the midpoint of the ink run it sits in.
 */
function recenter(pts: Pt[], mask: Uint8Array, w: number, h: number, reach: number): Pt[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[Math.floor(y) * w + Math.floor(x)] === 1;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) return p;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const run = (sgn: number) => {
      let t = 0;
      while (t < reach && inside(p.x + sgn * nx * (t + 0.25), p.y + sgn * ny * (t + 0.25))) t += 0.25;
      return t;
    };
    const tp = run(1), tm = run(-1);
    if (tp >= reach || tm >= reach) return p;
    const shift = (tp - tm) / 2;
    return { x: p.x + nx * shift, y: p.y + ny * shift };
  });
}

// ---------- main ----------

export interface CenterlineOptions {
  /** Longest side to work at; larger inputs are downscaled (SVG scales back up via viewBox). */
  maxSide?: number;
}

/** The ink in an RGBA buffer split into per-colour 1-px masks, and the solid blobs. */
export async function traceCenterline(png: Buffer, opts: CenterlineOptions = {}): Promise<CenterlineResult | null> {
  const meta = await sharp(png).metadata();
  const sx = Math.min(1, (opts.maxSide ?? 2000) / Math.max(meta.width ?? 1, meta.height ?? 1));
  let img = sharp(png).ensureAlpha();
  if (sx < 1) img = img.resize(Math.round(meta.width! * sx), Math.round(meta.height! * sx));
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  const rgba = Buffer.from(data);
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = rgba[i * 4 + 3] >= 128 ? 255 : 0;

  const palette = inkPalette(rgba, n);
  if (!palette.length) return null;
  const owner = new Int16Array(n).fill(-1);
  let ink = 0;
  for (;;) {
    const count = new Array(palette.length).fill(0);
    ink = 0;
    for (let i = 0; i < n; i++) {
      if (!rgba[i * 4 + 3]) continue;
      ink++;
      const c: RGB = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
      let b = 0, bd = Infinity;
      palette.forEach((p, k) => {
        const d = d2(c, p);
        if (d < bd) (bd = d), (b = k);
      });
      owner[i] = b;
      count[b]++;
    }
    // Colours that own almost nothing are anti-aliasing blends where two inks meet: fold them into their neighbours.
    const small = count.findIndex((c) => c < Math.max(30, ink * 0.003));
    if (small < 0 || palette.length < 2) break;
    palette.splice(small, 1);
  }
  if (!ink) return null;

  const blob = new Uint8Array(n);
  const groups: { colour: string; paths: { pts: Pt[]; width: number }[] }[] = [];
  let thinArea = 0, widthSum = 0, widthN = 0, pathCount = 0;

  palette.forEach((col, k) => {
    const mask = new Uint8Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) if (owner[i] === k) (mask[i] = 1), area++;
    if (area < 4) return;
    // Solid regions: core = far from any edge, blob = everything within 1.8 T of a core pixel.
    const dt = chamfer(mask, w, h);
    const core = new Uint8Array(n);
    let cores = 0;
    const T = Math.min(BLOB_MAX, Math.max(BLOB_MIN, lineHalfWidth(dt, mask, w, h) * 2.2 + 0.5));
    for (let i = 0; i < n; i++) if (dt[i] >= T) (core[i] = 1), cores++;
    if (cores) {
      const dc = chamfer(core, w, h, true);
      for (let i = 0; i < n; i++) if (mask[i] && dc[i] <= T * 1.8) (blob[i] = 1), (mask[i] = 0), area--;
    }
    if (area < 4) return;
    thinArea += area;

    const sk = thin(mask, w, h);
    const pathOf = new Int32Array(n);
    const raw = skeletonPaths(sk, w, h, pathOf);
    const areas = assignArea(mask, pathOf, w, h, raw.length);

    const paths: { pts: Pt[]; width: number }[] = [];
    raw.forEach((r, idx) => {
      const len = polylineLength(smoothPath(r.pts, 3));
      const A = areas[idx + 1];
      // Area of a stroke with round caps ≈ w·(len + w): solve for w.
      const wd = Math.max(1, (-len + Math.sqrt(len * len + 4 * A)) / 2);
      // Zero-length slivers between adjacent junction pixels (a genuine dot has no junction).
      if (len < 2 && !(r.tipStart && r.tipEnd)) return;
      // Short free-ended stubs are thinning spurs or specks, not line work.
      if ((r.tipStart || r.tipEnd) && len < Math.max(3, wd * 1.2) && (r.tipStart && r.tipEnd ? A < 10 : true)) return;
      paths.push({ pts: recenter(r.pts, mask, w, h, wd * 2 + 4), width: wd });
    });
    if (!paths.length) return;

    // Clean-up: join, simplify/straighten/snap, align, close gaps.
    const joined = joinCollinearPaths(paths.map((p) => p.pts), 2.5);
    const widthFor = (pts: Pt[]) => {
      // Widest-weighted match: inherit from the original path whose end point is nearest.
      let best = paths[0], bd = Infinity;
      for (const p of paths) {
        const d = Math.min(Math.hypot(p.pts[0].x - pts[0].x, p.pts[0].y - pts[0].y), Math.hypot(p.pts[0].x - pts[pts.length - 1].x, p.pts[0].y - pts[pts.length - 1].y));
        if (d < bd) (bd = d), (best = p);
      }
      return best.width;
    };
    // Lines another colour crosses over come out in pieces: bridge gaps filled by foreign ink, then tidy again.
    const covered = (x: number, y: number) => {
      const i = Math.floor(y) * w + Math.floor(x);
      return owner[i] >= 0;
    };
    const maxW = Math.max(...paths.map((p) => p.width));
    const bridged = bridgeGaps(
      joined.map((pts) => cleanPath(pts, 0.6, widthFor(pts))),
      Math.max(12, maxW * 4),
      covered,
    );
    const clean = bridged.map((pts) => cleanPath(pts, 0.6, widthFor(pts), false));
    alignAxisLines(clean, 2);
    joinEndpoints(clean, 1.5);
    const out = clean.map((pts) => ({ pts, width: widthFor(pts) }));
    for (const p of out) (widthSum += p.width * polylineLength(p.pts)), (widthN += polylineLength(p.pts));
    pathCount += out.length;
    groups.push({ colour: hex(col), paths: out });
  });

  const blobCount = blob.reduce((s, v) => s + v, 0);
  let blobs: Buffer | null = null;
  if (blobCount) {
    blobs = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++)
      if (blob[i]) {
        blobs[i * 4] = rgba[i * 4];
        blobs[i * 4 + 1] = rgba[i * 4 + 1];
        blobs[i * 4 + 2] = rgba[i * 4 + 2];
        blobs[i * 4 + 3] = 255;
      }
    blobs = await sharp(blobs, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  }
  const f = (v: number) => +v.toFixed(2);
  const body = groups
    .map(
      (g) =>
        `<g fill="none" stroke="${g.colour}" stroke-linecap="round" stroke-linejoin="round">` +
        g.paths.map((p) => `<path stroke="${g.colour}" stroke-width="${f(p.width)}" d="${pathData(p.pts, f)}"/>`).join("") +
        `</g>`,
    )
    .join("");
  return {
    body,
    width: w,
    height: h,
    blobs,
    blobShare: blobCount / ink,
    coverage: ink / n,
    strokeWidth: widthN ? widthSum / widthN : 0,
    paths: pathCount,
  };
}

/** SVG path data: straight polyline, or a smooth spline when every turn is gentle (a curve, not a corner). */
function pathData(pts: Pt[], f: (v: number) => number): string {
  if (pts.length === 1) return `M${f(pts[0].x)} ${f(pts[0].y)}l0.01 0`;
  const line = () => "M" + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join("L");
  if (pts.length < 4) return line();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x), b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
    let t = Math.abs(a - b);
    if (t > Math.PI) t = 2 * Math.PI - t;
    if (t > (50 * Math.PI) / 180) return line();
  }
  // Catmull–Rom → cubic Bézier.
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}
