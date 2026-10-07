import { createRequire } from "node:module";
import sharp from "sharp";
import { removeBackground, trimTransparent } from "./raster.js";
import { traceCenterline } from "./centerline.js";

const require = createRequire(import.meta.url);
const vtracer: {
  convertBuffer(buf: Uint8Array, opts?: Record<string, unknown>): string;
} = require("@visioncortex/vtracer");

/** Tuned for flat icons: few colors, smooth curves, small specks dropped. */
export const FLAT_ICON_OPTIONS = {
  clustering: "color-cluster",
  hierarchical: "stacked",
  mode: "spline",
  filterSpeckle: 6,
  colorPrecision: 6,
  layerDifference: 24,
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  pathPrecision: 2,
  maxColors: 10,
  optimize: 2,
};

const MIN_TRACE_SIDE = 768;

/**
 * Raster icon → clean SVG: background removed, upscaled so anti-aliased edges trace
 * smoothly, traced with vtracer, then given a viewBox so it scales.
 */
export async function vectorize(png: Buffer, opts: { removeBg?: boolean } = {}): Promise<string> {
  return (await traceImage(png, opts)).svg;
}

/** Longest side we trace at; small or thin elements are scaled up toward it for cleaner curves. */
const MAX_TRACE_SIDE = 3000;
const MAX_UPSCALE = 4;

/**
 * Bound, upscale, trace. The element is cropped to its own opaque extent first, then scaled so its
 * SHORT side reaches MIN_TRACE_SIDE (thin strokes survive), capped by MAX_TRACE_SIDE / MAX_UPSCALE.
 * Returns the SVG and how faithfully it reproduces the bounded source (see traceFidelity).
 */
export type TraceMethod = "fill" | "centerline";

/** A fill trace at least this faithful is kept without trying the (slower) centreline trace. */
const CENTERLINE_SKIP_ABOVE = 0.98;

export async function traceImage(
  png: Buffer,
  opts: { removeBg?: boolean; centerline?: boolean } = {},
): Promise<{ svg: string; fidelity: number; source: Buffer; method: TraceMethod }> {
  // Already-transparent input (e.g. a model-split layer) keeps its own alpha.
  const keep = opts.removeBg === false || (await isTransparent(png));
  const source = await trimTransparent(await hardenAlpha(keep ? png : await removeBackground(png)));
  const { width = 1, height = 1 } = await sharp(source).metadata();
  const scale = Math.min(MAX_UPSCALE, MAX_TRACE_SIDE / Math.max(width, height), Math.max(1, MIN_TRACE_SIDE / Math.min(width, height)));
  const upscale = async (buf: Buffer, k: number, w0 = width, h0 = height) =>
    k > 1 ? hardenAlpha(await sharp(buf).resize(Math.round(w0 * k), Math.round(h0 * k), { kernel: "lanczos3" }).png().toBuffer()) : buf;
  const img = await upscale(source, scale);
  const svg = finalizeSvg(vtracer.convertBuffer(img, FLAT_ICON_OPTIONS));
  const fill = { svg, fidelity: await traceFidelity(source, svg), source, method: "fill" as TraceMethod };
  if (opts.centerline === false || fill.fidelity >= CENTERLINE_SKIP_ABOVE) return fill;

  // Thin-line art (axes, curves, arrows) traces thick and wobbly as filled shapes: try strokes along the centrelines.
  try {
    const csvg = await centerlineSvg(source);
    if (csvg) {
      const fidelity = await traceFidelity(source, csvg);
      if (fidelity > fill.fidelity) return { svg: csvg, fidelity, source, method: "centerline" };
    }
  } catch {
    // Centreline is best-effort; the fill trace stands.
  }
  return fill;
}

/**
 * Centreline SVG for a (hardened, trimmed) transparent source: stroked paths for the thin line work,
 * with any solid blobs (arrowheads, filled shapes) traced by vtracer and composed in. Null when the
 * image has no line work worth stroking.
 */
export async function centerlineSvg(source: Buffer): Promise<string | null> {
  const cl = await traceCenterline(source);
  if (!cl || !cl.paths || cl.blobShare > 0.6) return null;
  let inner = "";
  if (cl.blobs) {
    const bs = Math.min(MAX_UPSCALE, MAX_TRACE_SIDE / Math.max(cl.width, cl.height), Math.max(1, MIN_TRACE_SIDE / Math.min(cl.width, cl.height)));
    const big = bs > 1 ? await hardenAlpha(await sharp(cl.blobs).resize(Math.round(cl.width * bs), Math.round(cl.height * bs), { kernel: "lanczos3" }).png().toBuffer()) : cl.blobs;
    const blobSvg = finalizeSvg(vtracer.convertBuffer(big, FLAT_ICON_OPTIONS));
    inner = `<g transform="scale(${+(1 / bs).toFixed(5)})">${blobSvg.replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>$/, "")}</g>`;
  }
  return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${cl.width}" height="${cl.height}" viewBox="0 0 ${cl.width} ${cl.height}">${inner}${cl.body}</svg>`;
}

/** True when the image already has a transparent margin (all four corners clear). */
async function isTransparent(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  return [0, w - 1, (h - 1) * w, h * w - 1].every((i) => data[i * 4 + 3] < 16);
}

/**
 * vtracer traces any non-zero alpha as colour, so faint residue (anti-aliasing, layer-model noise,
 * resampling halos) turns into dark specks. Snap alpha to fully clear or fully opaque.
 */
async function hardenAlpha(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Strip the XML prolog/comment and add a viewBox derived from width/height. */
export function finalizeSvg(raw: string): string {
  let svg = raw.replace(/<\?xml[^>]*\?>\s*/, "").replace(/<!--[\s\S]*?-->\s*/g, "");
  const m = svg.match(/<svg\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/);
  if (m && !/viewBox=/.test(svg)) svg = svg.replace("<svg", `<svg viewBox="0 0 ${m[1]} ${m[2]}"`);
  return svg.trim();
}

/** Distinct fill colors in an SVG, most-used first (drives the workspace palette). */
export function svgFills(svg: string): string[] {
  const counts = new Map<string, number>();
  for (const m of svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)) {
    const c = m[1].toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/**
 * How closely a traced SVG reproduces its source pixels (0..1). Both are composited on white at the
 * source size; the score is 1 − mean colour error over pixels that are ink in either image.
 */
export async function traceFidelity(png: Buffer, svg: string): Promise<number> {
  const src = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = src.info;
  const flat = async (img: sharp.Sharp) => (await img.flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer());
  const a = await flat(sharp(png));
  // The source alpha is hardened (binary), so harden the render's anti-aliased edges the same way;
  // otherwise even a perfect thin stroke is penalised for sub-pixel edge coverage.
  const r = await sharp(Buffer.from(svg), { density: 72 }).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < r.length; i += 4) r[i] = r[i] >= 128 ? 255 : 0;
  const b = await flat(sharp(r, { raw: { width, height, channels: 4 } }));
  let err = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    const ink = src.data[i * 4 + 3] > 16 || b[i * 3] < 245 || b[i * 3 + 1] < 245 || b[i * 3 + 2] < 245;
    if (!ink) continue;
    n++;
    err += (Math.abs(a[i * 3] - b[i * 3]) + Math.abs(a[i * 3 + 1] - b[i * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[i * 3 + 2])) / 765;
  }
  return n ? 1 - err / n : 1;
}
