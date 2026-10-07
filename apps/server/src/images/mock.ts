import sharp from "sharp";
import type { BBox, ConceptGraph } from "@diagram/core";
import { removeBackground } from "../vector/raster.js";
import type { ImageProvider } from "./types.js";

export const MOCK_W = 1200;
export const MOCK_H = 800;

/** Where the mock candidate draws each node (normalized); the mock decomposer reads the same boxes. */
export function mockNodeBoxes(n: number): { icon: BBox; label: BBox }[] {
  const margin = 0.06;
  const slot = (1 - 2 * margin) / n;
  const side = Math.min(slot * 0.62, 0.2); // fraction of width
  const hFrac = (side * MOCK_W) / MOCK_H; // keep icons square in pixels
  return Array.from({ length: n }, (_, i) => {
    const cx = margin + slot * (i + 0.5);
    const icon = { x: cx - side / 2, y: 0.42 - hFrac / 2, w: side, h: hFrac };
    const label = { x: cx - slot / 2 + 0.01, y: icon.y + icon.h + 0.03, w: slot - 0.02, h: 0.06 };
    return { icon, label };
  });
}

function shape(kind: number, x: number, y: number, s: number, fill: string, accent: string, ink: string): string {
  const cx = x + s / 2;
  const cy = y + s / 2;
  const r = s / 2;
  const outer = [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${ink}" stroke-width="6"/>`,
    `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.18}" fill="${fill}" stroke="${ink}" stroke-width="6"/>`,
    `<polygon points="${cx},${y} ${x + s},${cy} ${cx},${y + s} ${x},${cy}" fill="${fill}" stroke="${ink}" stroke-width="6"/>`,
    `<polygon points="${[0, 1, 2, 3, 4, 5].map((k) => `${cx + r * Math.cos((Math.PI / 3) * k)},${cy + r * Math.sin((Math.PI / 3) * k)}`).join(" ")}" fill="${fill}" stroke="${ink}" stroke-width="6"/>`,
  ][kind % 4];
  const inner = `<circle cx="${cx}" cy="${cy}" r="${r * 0.38}" fill="${accent}"/><rect x="${cx - r * 0.12}" y="${cy - r * 0.12}" width="${r * 0.24}" height="${r * 0.24}" fill="#ffffff"/>`;
  return outer + inner;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

export function mockCandidateSvg(g: ConceptGraph, variant: number): string {
  const colors = g.palette.map((p) => p.hex);
  const ink = colors.at(-1)!;
  const boxes = mockNodeBoxes(g.nodes.length);
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  let body = "";
  for (const e of g.edges) {
    const a = boxes[idx.get(e.from) ?? 0].icon;
    const b = boxes[idx.get(e.to) ?? 0].icon;
    const x1 = (a.x + a.w) * MOCK_W + 14;
    const x2 = b.x * MOCK_W - 22;
    const y = (a.y + a.h / 2) * MOCK_H;
    body += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${ink}" stroke-width="6"/>`;
    body += `<polygon points="${x2},${y - 14} ${x2 + 20},${y} ${x2},${y + 14}" fill="${ink}"/>`;
  }
  g.nodes.forEach((n, i) => {
    const { icon, label } = boxes[i];
    const s = icon.w * MOCK_W - 8;
    const fill = colors[(i + variant) % (colors.length - 1)];
    const accent = colors[(i + variant + 1) % (colors.length - 1)];
    body += shape(i + variant, icon.x * MOCK_W + 4, icon.y * MOCK_H + 4, s, fill, accent, ink);
    body += `<text x="${(label.x + label.w / 2) * MOCK_W}" y="${(label.y + label.h * 0.7) * MOCK_H}" font-family="Helvetica, Arial" font-size="30" font-weight="600" text-anchor="middle" fill="${ink}">${escapeXml(n.label)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MOCK_W}" height="${MOCK_H}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
}

/**
 * Offline image provider. Candidates are drawn from the concept graph; regeneration
 * echoes the crop (first reference) so the downstream vector steps run on real pixels.
 */
export const mockImages: ImageProvider = async (req) => {
  const ctx = req.context as
    | { kind: "candidate"; graph: ConceptGraph; variant: number }
    | { kind: "regen" }
    | { kind: "layers" }
    | { kind: "prototype"; node: { id: string } }
    | undefined;
  if (ctx?.kind === "prototype") {
    const hue = [...ctx.node.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#fff"/><circle cx="128" cy="128" r="80" fill="hsl(${hue},60%,55%)" stroke="#222" stroke-width="8"/></svg>`;
    return [{ data: await sharp(Buffer.from(svg)).png().toBuffer(), mediaType: "image/png" }];
  }
  if (ctx?.kind === "layers" && req.references?.[0]) {
    // Like a layer model: foreground on transparent, then an opaque background layer.
    const ref = req.references[0];
    const { width = 1, height = 1 } = await sharp(ref).metadata();
    const bg = await sharp({ create: { width, height, channels: 4, background: "#ffffff" } }).png().toBuffer();
    return [
      { data: await removeBackground(ref), mediaType: "image/png" },
      { data: bg, mediaType: "image/png" },
    ];
  }
  if (ctx?.kind === "candidate") {
    return Promise.all(
      Array.from({ length: req.n ?? 1 }, async (_, i) => ({
        data: await sharp(Buffer.from(mockCandidateSvg(ctx.graph, ctx.variant + i))).png().toBuffer(),
        mediaType: "image/png",
      })),
    );
  }
  if (req.references?.[0]) return [{ data: req.references[0], mediaType: "image/png" }];
  throw new Error("mock image provider needs a candidate context or a reference image");
};
