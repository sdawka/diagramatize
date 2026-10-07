import ELK from "elkjs/lib/elk.bundled.js";
import type { Component, ConceptGraph, ImageText, Scene, SceneEdge, SceneNode, SceneText } from "@diagram/core";

export const CANVAS_W = 1600;

export interface LayoutInput {
  graph: ConceptGraph;
  components: Component[];
  /** Pixel size of the picked candidate image (sets the canvas aspect). */
  source: { width: number; height: number };
  /** SVG markup per component id (for aspect ratios). */
  svgs: Record<string, string>;
  /** Text read from the image (whole-layer mode); placed as free text in the original layout. */
  texts?: ImageText[];
  background?: string;
}

export function svgAspect(svg: string): number {
  const vb = svg.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
  if (vb) return Number(vb[1]) / Number(vb[2]) || 1;
  return 1;
}

/** SVG viewBox aspect, or for original-pixel (PNG) assets the element's own box in the source image. */
function aspectOf(c: Component, svgs: Record<string, string>, source: { width: number; height: number }) {
  return svgs[c.id] ? svgAspect(svgs[c.id]) : (c.bbox.w * source.width) / (c.bbox.h * source.height) || 1;
}

/** Fit an item of aspect `a` inside a w×h box, centered. */
function fit(x: number, y: number, w: number, h: number, a: number) {
  const fw = Math.min(w, h * a);
  const fh = fw / a;
  return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh };
}

const ink = (g: ConceptGraph) => g.palette.at(-1)?.hex ?? "#1f2937";

function labelFor(g: ConceptGraph, c: Component) {
  return c.nodeRef ? g.nodes.find((n) => n.id === c.nodeRef)?.label ?? null : null;
}

function edgesFor(g: ConceptGraph, nodes: SceneNode[]): SceneEdge[] {
  const byRef = new Map(nodes.filter((n) => n.nodeRef).map((n) => [n.nodeRef!, n.id]));
  return g.edges.flatMap((e, i) => {
    const from = byRef.get(e.from);
    const to = byRef.get(e.to);
    if (!from || !to) return [];
    return [{ id: `e${i}`, from, to, label: e.label, style: e.style, color: ink(g) }];
  });
}

/** Keep each component where it sat in the picked image. */
export function layoutOriginal({ graph, components, source, svgs, texts = [], background = "#ffffff" }: LayoutInput): Scene {
  const W = CANVAS_W;
  const H = Math.round((W * source.height) / source.width);
  const nodes: SceneNode[] = components
    .filter((c) => c.include && c.svg)
    .map((c) => {
      const box = fit(c.bbox.x * W, c.bbox.y * H, c.bbox.w * W, c.bbox.h * H, aspectOf(c, svgs, source));
      const text = labelFor(graph, c);
      let label: SceneNode["label"] = null;
      if (text) {
        const lb = c.labelBox;
        const fontSize = Math.round(Math.min(40, Math.max(16, lb ? lb.h * H * 0.55 : 24)));
        label = lb
          ? { text, x: (lb.x + lb.w / 2) * W, y: (lb.y + lb.h / 2) * H, fontSize, color: ink(graph) }
          : { text, x: box.x + box.w / 2, y: box.y + box.h + fontSize, fontSize, color: ink(graph) };
      }
      return { id: c.id, componentId: c.id, nodeRef: c.nodeRef, svg: c.svg!, ...box, label };
    });
  // Containers render behind icons.
  nodes.sort((a, b) => Number(isContainer(components, b)) - Number(isContainer(components, a)));
  return { width: W, height: H, background, layout: "original", nodes, edges: edgesFor(graph, nodes), texts: sceneTexts(texts, W, H) };
}

function sceneTexts(texts: ImageText[], W: number, H: number): SceneText[] {
  return texts.map((t, i) => {
    const h = t.bbox.h * H;
    // A tight box spans roughly one em per line plus inter-line gaps (Fabric line height 1.16).
    const fontSize = Math.round(Math.min(160, Math.max(10, h / (t.lines * 1.16 - 0.2))));
    return { id: `t${i}`, text: t.text, x: t.bbox.x * W, y: t.bbox.y * H, w: t.bbox.w * W, h, fontSize, color: t.color, bold: t.bold, align: t.align };
  });
}

const isContainer = (cs: Component[], n: SceneNode) => cs.find((c) => c.id === n.componentId)?.role === "container";

const ICON = 180;
const LABEL_H = 48;
const GAP = 90;

/** Re-arrange node icons from the concept graph's layout intent. */
export async function layoutAuto(input: LayoutInput): Promise<Scene> {
  const { graph, components, svgs } = input;
  const icons = components.filter((c) => c.include && c.svg && c.role !== "container");
  const sized = icons.map((c) => {
    const a = aspectOf(c, svgs, input.source);
    const w = a >= 1 ? ICON : ICON * a;
    const h = a >= 1 ? ICON / a : ICON;
    return { c, w, h };
  });

  let pos: Map<string, { x: number; y: number }>;
  const intent = graph.layoutIntent;
  if (intent === "flow" || intent === "hierarchy" || intent === "cycle") {
    pos = await elkLayered(graph, sized);
  } else if (intent === "radial") {
    pos = radial(graph, sized);
  } else {
    pos = grid(sized);
  }

  const xs = sized.map((s) => pos.get(s.c.id)!);
  const maxX = Math.max(...sized.map((s, i) => xs[i].x + Math.max(s.w, 220)));
  const maxY = Math.max(...sized.map((s, i) => xs[i].y + s.h + LABEL_H));
  const W = Math.max(CANVAS_W, maxX + GAP * 2);
  const H = Math.max(600, maxY + GAP * 2);
  const offX = (W - maxX) / 2;
  const offY = (H - maxY) / 2;

  const nodes: SceneNode[] = sized.map(({ c, w, h }) => {
    const p = pos.get(c.id)!;
    const x = p.x + offX;
    const y = p.y + offY;
    const text = labelFor(graph, c);
    return {
      id: c.id,
      componentId: c.id,
      nodeRef: c.nodeRef,
      svg: c.svg!,
      x,
      y,
      w,
      h,
      label: text ? { text, x: x + w / 2, y: y + h + 30, fontSize: 26, color: ink(graph) } : null,
    };
  });
  return { width: Math.round(W), height: Math.round(H), background: "#ffffff", layout: "auto", nodes, edges: edgesFor(graph, nodes), texts: [] };
}

type Sized = { c: Component; w: number; h: number };

async function elkLayered(graph: ConceptGraph, sized: Sized[]) {
  const elk = new ELK();
  const ids = new Set(sized.map((s) => s.c.id));
  const refToId = new Map(sized.filter((s) => s.c.nodeRef).map((s) => [s.c.nodeRef!, s.c.id]));
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": graph.direction,
      "elk.spacing.nodeNode": String(GAP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(GAP * 1.4),
      "elk.edgeRouting": "ORTHOGONAL",
    },
    // Reserve room for the label under each icon.
    children: sized.map((s) => ({ id: s.c.id, width: Math.max(s.w, 200), height: s.h + LABEL_H })),
    edges: graph.edges
      .map((e, i) => ({ id: `e${i}`, sources: [refToId.get(e.from) ?? ""], targets: [refToId.get(e.to) ?? ""] }))
      .filter((e) => ids.has(e.sources[0]) && ids.has(e.targets[0])),
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const ch of res.children ?? []) {
    const s = sized.find((z) => z.c.id === ch.id)!;
    // Center the icon horizontally in its (label-width) slot.
    pos.set(ch.id, { x: (ch.x ?? 0) + (Math.max(s.w, 200) - s.w) / 2, y: ch.y ?? 0 });
  }
  return pos;
}

function grid(sized: Sized[]) {
  const cols = Math.ceil(Math.sqrt(sized.length * 1.6));
  const cell = Math.max(ICON, 220) + GAP;
  return new Map(
    sized.map((s, i) => [s.c.id, { x: (i % cols) * cell + (cell - GAP - s.w) / 2, y: Math.floor(i / cols) * (ICON + LABEL_H + GAP) }]),
  );
}

function radial(graph: ConceptGraph, sized: Sized[]) {
  const degree = (ref: string | null) => graph.edges.filter((e) => e.from === ref || e.to === ref).length;
  const hub = [...sized].sort((a, b) => degree(b.c.nodeRef) - degree(a.c.nodeRef))[0];
  const rest = sized.filter((s) => s !== hub);
  const R = Math.max(320, (rest.length * (ICON + GAP)) / (2 * Math.PI));
  const pos = new Map<string, { x: number; y: number }>();
  pos.set(hub.c.id, { x: R - hub.w / 2 + 110, y: R - hub.h / 2 });
  rest.forEach((s, i) => {
    const t = (2 * Math.PI * i) / rest.length - Math.PI / 2;
    pos.set(s.c.id, { x: R + R * Math.cos(t) - s.w / 2 + 110, y: R + R * Math.sin(t) - s.h / 2 });
  });
  // Shift so nothing is negative.
  const minX = Math.min(...[...pos.values()].map((p) => p.x));
  const minY = Math.min(...[...pos.values()].map((p) => p.y));
  for (const p of pos.values()) {
    p.x -= minX;
    p.y -= minY;
  }
  return pos;
}
