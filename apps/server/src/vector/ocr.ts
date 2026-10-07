import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { BBox } from "@diagram/core";

/** A recognised run of text with a pixel box on the image it was read from. */
export interface OcrSegment {
  text: string;
  /** Pixel box, x1/y1 exclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrResult {
  width: number;
  height: number;
  segments: OcrSegment[];
}

const CACHE_DIR =
  process.env.OCR_CACHE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../data/ocr");

/** Words further apart than this many line-heights belong to different text blocks. */
const SEGMENT_GAP = 1.2;
const MIN_CONFIDENCE = 30;

/** OCR is skipped for the mock provider and when switched off, so offline and test runs stay fast. */
export function ocrEnabled(): boolean {
  return process.env.OCR_DISABLE !== "1" && process.env.LLM_PROVIDER !== "mock";
}

/**
 * Read the text of an image with tesseract.js (Apache-2.0; language data is fetched once into the
 * cache dir). Words are grouped into segments: same row, small gaps — so two labels side by side
 * stay separate. Returns null when OCR is unavailable (no data, no network, engine error).
 */
export async function ocrImage(png: Buffer): Promise<OcrResult | null> {
  let worker: import("tesseract.js").Worker | null = null;
  try {
    const { createWorker } = await import("tesseract.js");
    const { data: flat, info } = await sharp(png).flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
    worker = await createWorker("eng", 1, { cachePath: CACHE_DIR });
    const read = async (img: Buffer) => {
      const res = await worker!.recognize(img, {}, { blocks: true });
      const words: OcrSegment[] = [];
      for (const b of res.data.blocks ?? [])
        for (const p of b.paragraphs)
          for (const l of p.lines)
            for (const w of l.words) {
              const text = w.text.trim();
              if (!text || w.confidence < MIN_CONFIDENCE) continue;
              words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence });
            }
      return groupWords(words);
    };
    const segments = await read(flat);
    // Light lettering on dark fills is invisible to the engine's binarizer: read a second image where it is dark.
    try {
      for (const s of await read(await lightOnDarkToDark(flat))) {
        const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
        if (!segments.some((o) => cx >= o.x0 && cx <= o.x1 && cy >= o.y0 && cy <= o.y1)) segments.push(s);
      }
    } catch {
      // the first pass stands
    }
    return { width: info.width, height: info.height, segments };
  } catch {
    return null;
  } finally {
    await worker?.terminate().catch(() => {});
  }
}

/** Greyscale copy for light-on-dark lettering: light pixels inside dark regions become dark, dark fills become white. */
async function lightOnDarkToDark(png: Buffer): Promise<Buffer> {
  const g = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = g.info;
  const dark = Buffer.alloc(width * height);
  for (let i = 0; i < dark.length; i++) dark[i] = g.data[i] < 170 ? 255 : 0;
  // Smoothing the dark mask closes the gaps the lettering leaves in a fill.
  const closed = await sharp(dark, { raw: { width, height, channels: 1 } }).blur(8).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < dark.length; i++) dark[i] = closed[i] > 100 ? 255 : 0;
  // Pull the region back inside the fill, so the page just outside its edge is not mistaken for lettering.
  const region = await sharp(dark, { raw: { width, height, channels: 1 } }).blur(5).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(dark.length);
  for (let i = 0; i < out.length; i++) out[i] = region[i] > 245 ? 255 - Math.min(255, Math.max(0, (g.data[i] - 170) * 3)) : g.data[i] < 170 ? 255 : g.data[i];
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/** Merge words on the same row with small gaps into line segments. */
export function groupWords(words: OcrSegment[]): OcrSegment[] {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  const segs: OcrSegment[] = [];
  for (const w of sorted) {
    const h = w.y1 - w.y0;
    const into = segs.find((s) => {
      const sh = s.y1 - s.y0;
      const rowOverlap = Math.min(s.y1, w.y1) - Math.max(s.y0, w.y0);
      return rowOverlap > 0.5 * Math.min(sh, h) && w.x0 - s.x1 < SEGMENT_GAP * Math.max(sh, h) && w.x0 >= s.x0;
    });
    if (into) {
      const n = into.text.split(/\s+/).length;
      into.text += " " + w.text;
      into.x1 = Math.max(into.x1, w.x1);
      into.y0 = Math.min(into.y0, w.y0);
      into.y1 = Math.max(into.y1, w.y1);
      into.confidence = (into.confidence * n + w.confidence) / (n + 1);
    } else segs.push({ ...w });
  }
  return segs;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for identical (ignoring case and punctuation), 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

const MATCH_MIN = 0.6;

/**
 * Give each text the box of the OCR segments that read like its lines. The text string stays the
 * model's (spelled right); only geometry comes from OCR. A text is matched only when every one of
 * its lines finds a segment near its estimated box — otherwise it is left alone (null).
 */
export function matchTexts<T extends { text: string; bbox: BBox }>(texts: T[], ocr: OcrResult): (BBox | null)[] {
  const { width: W, height: H } = ocr;
  const used = new Set<OcrSegment>();
  // Match the most distinctive (longest) texts first, so short labels don't steal their segments.
  const order = texts.map((_, i) => i).sort((a, b) => norm(texts[b].text).length - norm(texts[a].text).length);
  const out: (BBox | null)[] = texts.map(() => null);
  for (const i of order) {
    const t = texts[i];
    const gx = t.bbox.w * W * 0.4 + 6, gy = t.bbox.h * H * 0.4 + 6;
    const near = ocr.segments.filter((s) => {
      if (used.has(s)) return false;
      const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
      return cx >= t.bbox.x * W - gx && cx <= (t.bbox.x + t.bbox.w) * W + gx && cy >= t.bbox.y * H - gy && cy <= (t.bbox.y + t.bbox.h) * H + gy;
    });
    const lines = t.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const picked: OcrSegment[] = [];
    const lineSegs: (OcrSegment[] | null)[] = [];
    for (const line of lines) {
      let best: { segs: OcrSegment[]; sim: number } | null = null;
      // A line may be one segment or several consecutive ones on a row (OCR split a wide gap).
      for (const s of near) {
        if (picked.includes(s)) continue;
        const row = near
          .filter((o) => !picked.includes(o) && o.x0 >= s.x0 && Math.min(o.y1, s.y1) - Math.max(o.y0, s.y0) > 0.5 * (s.y1 - s.y0))
          .sort((a, b) => a.x0 - b.x0);
        const joined: OcrSegment[] = [];
        for (const o of row) {
          joined.push(o);
          const sim = similarity(joined.map((j) => j.text).join(" "), line);
          if (!best || sim > best.sim) best = { segs: [...joined], sim };
        }
      }
      if (best && best.sim >= MATCH_MIN) {
        picked.push(...best.segs);
        lineSegs.push(best.segs);
      } else lineSegs.push(null);
    }
    // Maths and symbols defeat OCR: accept a text when most of its characters were found, and place
    // the lines that were not found by their slot in the model's box.
    const total = lines.reduce((n, l) => n + norm(l).length, 0);
    const found = lines.reduce((n, l, k) => n + (lineSegs[k] ? norm(l).length : 0), 0);
    if (!picked.length || found < 0.5 * total) continue;
    for (const s of picked) used.add(s);
    let x0 = Math.min(...picked.map((s) => s.x0)), y0 = Math.min(...picked.map((s) => s.y0));
    let x1 = Math.max(...picked.map((s) => s.x1)), y1 = Math.max(...picked.map((s) => s.y1));
    const slot = (t.bbox.h * H) / lines.length;
    const ux0 = x0, ux1 = x1;
    lineSegs.forEach((segs, k) => {
      if (segs) return;
      y0 = Math.min(y0, t.bbox.y * H + k * slot);
      y1 = Math.max(y1, t.bbox.y * H + (k + 1) * slot);
      x0 = Math.min(x0, Math.max(ux0, t.bbox.x * W));
      x1 = Math.max(x1, Math.min(ux1, (t.bbox.x + t.bbox.w) * W));
    });
    out[i] = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  }
  return out;
}

/**
 * Text colour read from the pixels: the background is the median of the box's border ring, and the
 * ink is the average of the pixels furthest from it. Returns null when the box has no contrast.
 */
export async function inkColor(image: Buffer, box: BBox): Promise<string | null> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const x0 = Math.max(0, Math.floor(box.x * W)), y0 = Math.max(0, Math.floor(box.y * H));
  const x1 = Math.min(W, Math.ceil((box.x + box.w) * W)), y1 = Math.min(H, Math.ceil((box.y + box.h) * H));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const px = (x: number, y: number) => [data[(y * W + x) * 3], data[(y * W + x) * 3 + 1], data[(y * W + x) * 3 + 2]];
  const ring: number[][] = [];
  for (let x = x0; x < x1; x++) ring.push(px(x, y0), px(x, y1 - 1));
  for (let y = y0; y < y1; y++) ring.push(px(x0, y), px(x1 - 1, y));
  const med = [0, 1, 2].map((c) => ring.map((p) => p[c]).sort((a, b) => a - b)[ring.length >> 1]);
  const dist = (p: number[]) => Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]);
  const all: { p: number[]; d: number }[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(x, y); all.push({ p, d: dist(p) }); }
  const max = Math.max(...all.map((a) => a.d));
  if (max < 40) return null;
  const ink = all.filter((a) => a.d >= max * 0.85);
  const avg = [0, 1, 2].map((c) => Math.round(ink.reduce((s, a) => s + a.p[c], 0) / ink.length));
  return "#" + avg.map((v) => v.toString(16).padStart(2, "0")).join("");
}
