import {
  Canvas,
  Color,
  FabricImage,
  FabricObject,
  Group,
  IText,
  InteractiveFabricObject,
  Line,
  Point,
  Polygon,
  Text,
  loadSVGFromURL,
  util,
} from "fabric";
import type { Scene, SceneEdge, SceneNode, SceneText } from "@diagram/core";

export type ObjData =
  | { kind: "node"; id: string; componentId: string }
  | { kind: "label"; nodeId: string | null }
  | { kind: "edge" };

export const getData = (o: FabricObject | undefined): ObjData | undefined => (o as any)?.data;
const setData = (o: FabricObject, data: ObjData) => ((o as any).data = data);

// Clearer selection handles than Fabric's pale defaults (not serialized).
Object.assign(InteractiveFabricObject.ownDefaults, {
  borderColor: "#3b5bdb",
  borderScaleFactor: 1.5,
  cornerColor: "#ffffff",
  cornerStrokeColor: "#3b5bdb",
  cornerStyle: "circle",
  cornerSize: 11,
  transparentCorners: false,
});

export const findNode = (canvas: Canvas, id: string) =>
  canvas.getObjects().find((o) => {
    const d = getData(o);
    return d?.kind === "node" && d.id === id;
  });

/** Labels attached to any of the given node ids. */
export const labelsOf = (canvas: Canvas, nodeIds: Set<string>) =>
  canvas.getObjects().filter((o) => {
    const d = getData(o);
    return d?.kind === "label" && !!d.nodeId && nodeIds.has(d.nodeId);
  });

/** What we persist: Fabric JSON (without edge objects) + the edge list (edges are re-derived). */
export interface WorkspaceDoc {
  version: 1;
  width: number;
  height: number;
  fabric: object;
  edges: SceneEdge[];
  /** Scene SVG per node as of this save, so components rebuilt later can be swapped in on load. */
  svgs?: Record<string, string>;
}

/** Load a component asset: an SVG as recolourable paths, or original pixels (PNG) as an image. */
export async function loadSvgObject(url: string, signal?: AbortSignal): Promise<FabricObject> {
  if (!/\.svg(\?|$)/i.test(url)) return FabricImage.fromURL(url, { crossOrigin: "anonymous", signal });
  const { objects, options } = await loadSVGFromURL(url, undefined, { signal });
  const objs = objects.filter((o): o is FabricObject => !!o);
  if (!objs.length) throw new Error(`empty SVG: ${url}`);
  return util.groupSVGElements(objs, options);
}

/** Fit `obj` inside the given box (keeping aspect) and position it there. */
export function placeInBox(obj: FabricObject, box: { x: number; y: number; w: number; h: number }) {
  const s = Math.min(box.w / obj.width, box.h / obj.height);
  obj.set({
    scaleX: s,
    scaleY: s,
    originX: "left",
    originY: "top",
    left: box.x + (box.w - obj.width * s) / 2,
    top: box.y + (box.h - obj.height * s) / 2,
  });
  obj.setCoords();
}

export async function nodeObject(url: string, n: SceneNode, signal?: AbortSignal): Promise<FabricObject> {
  const obj = await loadSvgObject(url, signal);
  placeInBox(obj, n);
  setData(obj, { kind: "node", id: n.id, componentId: n.componentId });
  return obj;
}

export function labelObject(text: string, x: number, y: number, fontSize: number, color: string, nodeId: string | null) {
  const t = new IText(text, {
    left: x,
    top: y,
    originX: "center",
    originY: "center",
    fontSize,
    fill: color,
    fontFamily: "Inter, Helvetica, Arial, sans-serif",
    fontWeight: "600",
    textAlign: "center",
  });
  setData(t, { kind: "label", nodeId });
  return t;
}

/** Text read from the image, placed over its original box. */
export function freeTextObject(t: SceneText) {
  const o = new IText(t.text, {
    left: t.align === "left" ? t.x : t.align === "right" ? t.x + t.w : t.x + t.w / 2,
    top: t.y + t.h / 2,
    originX: t.align,
    originY: "center",
    fontSize: t.fontSize,
    fill: t.color,
    fontFamily: "Inter, Helvetica, Arial, sans-serif",
    fontWeight: t.bold ? "700" : "500",
    textAlign: t.align,
    // Diagram labels are set tight.
    lineHeight: t.text.includes("\n") ? 1.0 : 1.16,
  });
  // Our font differs from the image's lettering: shrink the type to fit the original box.
  const fit = Math.min(1, t.w / o.width, (t.h * 1.1) / o.height);
  if (fit < 1) o.set({ fontSize: Math.max(8, Math.round(t.fontSize * fit)) });
  setData(o, { kind: "label", nodeId: null });
  return o;
}

/** Returns the ids of nodes whose SVG failed to load. */
export async function buildFromScene(canvas: Canvas, scene: Scene, urlFor: (rel: string) => string, signal?: AbortSignal) {
  const nodes = await Promise.all(scene.nodes.map((n) => nodeObject(urlFor(n.svg), n, signal).catch(() => null)));
  signal?.throwIfAborted();
  canvas.clear();
  canvas.backgroundColor = scene.background;
  nodes.forEach((o) => o && canvas.add(o));
  for (const n of scene.nodes) {
    if (n.label) canvas.add(labelObject(n.label.text, n.label.x, n.label.y, n.label.fontSize, n.label.color, n.id));
  }
  for (const t of scene.texts ?? []) canvas.add(freeTextObject(t));
  return scene.nodes.filter((_, i) => !nodes[i]).map((n) => n.id);
}

// ---------- geometry ----------

/** Axis-aligned box of an object in scene coordinates (works inside groups/selections). */
export function sceneRect(o: FabricObject) {
  const m = o.calcTransformMatrix();
  const hw = o.width / 2;
  const hh = o.height / 2;
  const pts = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => util.transformPoint(new Point(x, y), m));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Point where the ray from the rect center toward (tx,ty) exits the rect, plus a gap. */
function exitPoint(r: ReturnType<typeof sceneRect>, tx: number, ty: number, gap: number) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
}

export function edgeObjects(canvas: Canvas, edges: SceneEdge[]): FabricObject[] {
  const byId = new Map<string, FabricObject>();
  for (const o of canvas.getObjects()) {
    const d = getData(o);
    if (d?.kind === "node") byId.set(d.id, o);
  }
  const out: FabricObject[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ra = sceneRect(a);
    const rb = sceneRect(b);
    const p1 = exitPoint(ra, rb.x + rb.w / 2, rb.y + rb.h / 2, 10);
    const p2 = exitPoint(rb, ra.x + ra.w / 2, ra.y + ra.h / 2, 12);
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const head = 16;
    const parts: FabricObject[] = [
      new Line([p1.x, p1.y, p2.x - Math.cos(angle) * head * 0.6, p2.y - Math.sin(angle) * head * 0.6], {
        stroke: e.color,
        strokeWidth: 4,
        strokeDashArray: e.style === "dashed" ? [14, 10] : undefined,
        strokeLineCap: "round",
      }),
    ];
    if (e.style !== "line") {
      const pt = (dist: number, off: number) => ({
        x: p2.x - Math.cos(angle) * dist - Math.sin(angle) * off,
        y: p2.y - Math.sin(angle) * dist + Math.cos(angle) * off,
      });
      parts.push(new Polygon([pt(0, 0), pt(head, head * 0.6), pt(head, -head * 0.6)], { fill: e.color }));
    }
    if (e.label) {
      parts.push(
        new Text(e.label, {
          left: (p1.x + p2.x) / 2,
          top: (p1.y + p2.y) / 2 - 16,
          originX: "center",
          originY: "center",
          fontSize: 18,
          fill: e.color,
          backgroundColor: "rgba(255,255,255,0.85)",
          fontFamily: "Inter, Helvetica, Arial, sans-serif",
        }),
      );
    }
    const g = new Group(parts, { selectable: false, evented: false, objectCaching: false });
    setData(g, { kind: "edge" });
    out.push(g);
  }
  return out;
}

/** Replace edge objects; they sit just below the lowest non-container node. */
export function refreshEdges(canvas: Canvas, edges: SceneEdge[]) {
  for (const o of canvas.getObjects()) if (getData(o)?.kind === "edge") canvas.remove(o);
  const objs = canvas.getObjects();
  const firstNode = objs.findIndex((o) => getData(o)?.kind === "node");
  const at = firstNode < 0 ? objs.length : firstNode;
  const fresh = edgeObjects(canvas, edges);
  if (fresh.length) canvas.insertAt(at, ...fresh);
  canvas.requestRenderAll();
}

// ---------- colors ----------

export const normColor = (c: unknown): string | null => {
  if (typeof c !== "string" || !c || c === "none" || c === "transparent") return null;
  try {
    return "#" + new Color(c).toHex().toLowerCase();
  } catch {
    return null;
  }
};

/** Leaf objects (descending into SVG groups), excluding edges. */
export function leaves(objs: FabricObject[]): FabricObject[] {
  const out: FabricObject[] = [];
  for (const o of objs) {
    if (getData(o)?.kind === "edge") continue;
    if (o instanceof Group) out.push(...leaves(o.getObjects()));
    else out.push(o);
  }
  return out;
}

/** Fill/stroke colors used by `objs`, most used first. */
export function usedColors(objs: FabricObject[], edges: SceneEdge[] = []): string[] {
  const counts = new Map<string, number>();
  const bump = (c: string | null) => c && counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const o of leaves(objs)) {
    bump(normColor(o.fill));
    bump(normColor(o.stroke));
  }
  for (const e of edges) bump(normColor(e.color));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export function replaceColor(objs: FabricObject[], from: string, to: string) {
  for (const o of leaves(objs)) {
    if (normColor(o.fill) === from) o.set("fill", to);
    if (normColor(o.stroke) === from) o.set("stroke", to);
    o.dirty = true;
  }
  for (const o of objs) o.dirty = true;
}

// ---------- persistence ----------

export function serialize(
  canvas: Canvas,
  edges: SceneEdge[],
  size: { width: number; height: number },
  svgs: Record<string, string>,
): WorkspaceDoc {
  const json = canvas.toObject(["data"]) as { objects: { data?: ObjData }[] };
  json.objects = json.objects.filter((o) => o.data?.kind !== "edge");
  return { version: 1, ...size, fabric: json, edges, svgs };
}

export const sceneSvgs = (scene: Scene) => Object.fromEntries(scene.nodes.map((n) => [n.id, n.svg]));

/**
 * Bring a restored canvas up to date with the scene. Nodes whose component was rebuilt since the save are
 * swapped in place (keeping the user's box), or re-added where the scene puts them if they had been removed.
 * Older saves without `seen` only get missing nodes back. Returns how many nodes changed.
 */
export async function reconcile(
  canvas: Canvas,
  scene: Scene,
  seen: Record<string, string> | undefined,
  urlFor: (rel: string) => string,
  signal?: AbortSignal,
) {
  const stale = scene.nodes.filter((n) => (seen ? seen[n.id] !== n.svg : !findNode(canvas, n.id)));
  const fresh = await Promise.all(stale.map((n) => loadSvgObject(urlFor(n.svg), signal).catch(() => null)));
  signal?.throwIfAborted();
  let changed = 0;
  stale.forEach((n, i) => {
    const obj = fresh[i];
    if (!obj) return;
    setData(obj, { kind: "node", id: n.id, componentId: n.componentId });
    const old = findNode(canvas, n.id);
    if (old) {
      placeInBox(obj, sceneRect(old));
      const idx = canvas.getObjects().indexOf(old);
      canvas.remove(old);
      canvas.insertAt(idx, obj);
    } else {
      placeInBox(obj, n);
      // Behind the text, like a fresh build.
      const firstText = canvas.getObjects().findIndex((o) => getData(o)?.kind === "label");
      if (firstText >= 0) canvas.insertAt(firstText, obj);
      else canvas.add(obj);
      if (n.label && !labelsOf(canvas, new Set([n.id])).length)
        canvas.add(labelObject(n.label.text, n.label.x, n.label.y, n.label.fontSize, n.label.color, n.id));
    }
    changed++;
  });
  return changed;
}

export async function restore(canvas: Canvas, doc: WorkspaceDoc, signal?: AbortSignal) {
  await canvas.loadFromJSON(doc.fabric, undefined, { signal });
  refreshEdges(canvas, doc.edges);
}
