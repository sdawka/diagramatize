import { z } from "zod";

// ---------- Stage 1: clarify ----------

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string().describe("Why the answer changes the diagram"),
  options: z.array(z.string()).describe("2-4 suggested answers; the user may also write their own"),
  suggested: z.string().optional().describe("Your best-guess answer (usually one of options), pre-selected so the user can just confirm"),
});
export type Question = z.infer<typeof Question>;

/** Dan Roam's six ways of seeing, used as the first-principles rubric. */
export const WayOfSeeing = z.enum(["who-what", "how-much", "where", "when", "how", "why"]);
export type WayOfSeeing = z.infer<typeof WayOfSeeing>;

export const Analysis = z.object({
  coreIdea: z.string().describe("One sentence: the essence of the concept"),
  firstPrinciples: z.array(z.string()).describe("The irreducible parts/mechanisms the diagram must show"),
  waysOfSeeing: z.array(WayOfSeeing).describe("Which questions the concept primarily answers"),
  recommendedDiagram: z.string().describe("e.g. 'left-to-right flow', 'cycle', 'layered stack', 'side-by-side comparison'"),
  rationale: z.string(),
});
export type Analysis = z.infer<typeof Analysis>;

export const ClarifyResult = z.object({
  analysis: Analysis,
  questions: z.array(Question).describe("0-4 questions; empty when nothing important is ambiguous"),
});
export type ClarifyResult = z.infer<typeof ClarifyResult>;

export const ClarifyRound = z.object({
  analysis: Analysis,
  questions: z.array(Question),
  answers: z.record(z.string(), z.string()).optional(),
});
export type ClarifyRound = z.infer<typeof ClarifyRound>;

// ---------- Stage 2: concept ----------

export const LayoutIntent = z.enum(["flow", "hierarchy", "cycle", "comparison", "radial", "spatial"]);
export type LayoutIntent = z.infer<typeof LayoutIntent>;

export const PaletteColor = z.object({
  name: z.string(),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const ConceptNode = z.object({
  id: z.string().describe("short kebab-case id"),
  label: z.string().describe("Short label text shown under the visual (1-4 words)"),
  visual: z.string().describe("What the icon/illustration for this node depicts, concretely"),
  group: z.string().optional().describe("Optional group/container id"),
});
export type ConceptNode = z.infer<typeof ConceptNode>;

export const ConceptEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  style: z.enum(["arrow", "line", "dashed"]).default("arrow"),
});
export type ConceptEdge = z.infer<typeof ConceptEdge>;

export const ConceptGraph = z.object({
  title: z.string(),
  mainPoint: z
    .string()
    .default("")
    .describe("The single takeaway the figure must make obvious, as one plain sentence a viewer could repeat"),
  mainPointAlternatives: z
    .array(z.string())
    .default([])
    .describe("Only if the main point is genuinely ambiguous: 1-3 other plausible takeaways for the user to choose from; else empty"),
  prose: z.string().describe("The diagram concept described in words (markdown, ~100-200 words)"),
  layoutIntent: LayoutIntent,
  direction: z.enum(["RIGHT", "DOWN"]).default("RIGHT"),
  style: z.string().describe("Visual style notes: flat, line weight, mood"),
  palette: z.array(PaletteColor).min(2).max(6),
  nodes: z.array(ConceptNode).min(1).max(12),
  edges: z.array(ConceptEdge),
  imagePrompt: z.string().describe("Complete prompt for an image model to render the whole diagram"),
});
export type ConceptGraph = z.infer<typeof ConceptGraph>;

// ---------- Stage 3: composition ----------

export const ASPECT_RATIOS = ["16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"] as const;
export const AspectRatio = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const Emphasis = z.enum(["focal", "primary", "secondary"]);
export type Emphasis = z.infer<typeof Emphasis>;

/** Where one concept node sits in the frame (normalized 0-1 box of its visual, label excluded). */
export const CompositionItem = z.object({
  nodeRef: z.string().describe("Concept node id"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.02).max(1),
  emphasis: Emphasis.describe("focal = carries the main point (exactly one or two), primary = key actors, secondary = supporting"),
});
export type CompositionItem = z.infer<typeof CompositionItem>;

export const CompositionPanel = z.object({
  label: z.string().describe("Short panel title, e.g. 'A  Healthy' or 'Normal state'"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.05).max(1),
  h: z.number().min(0.05).max(1),
});
export type CompositionPanel = z.infer<typeof CompositionPanel>;

/** A one-shot image of the whole figure laid out in a composition. */
export const CompositionDraft = z.object({
  file: z.string(),
  model: z.string(),
  ms: z.number().optional(),
  cost: z.number().nullable().optional(),
});
export type CompositionDraft = z.infer<typeof CompositionDraft>;

export const Composition = z.object({
  id: z.string().describe("short kebab-case id"),
  name: z.string().describe("2-5 words, e.g. 'Left-to-right pipeline', 'Hub and spokes', 'Before / after panels'"),
  rationale: z.string().describe("One or two sentences: why this arrangement serves the main point"),
  aspectRatio: AspectRatio,
  readingOrder: z.string().describe("How the eye travels, e.g. 'left to right, then down into the inset'"),
  focal: z.string().describe("How the main point is made visually dominant (size, position, color, isolation)"),
  panels: z.array(CompositionPanel).default([]).describe("Optional sub-panels/regions for multi-panel figures; usually empty"),
  items: z.array(CompositionItem).describe("One entry per concept node, non-overlapping, leaving room for labels under each"),
  /** One-shot draft of the whole figure in this composition (set by the server, not the planner). */
  draft: CompositionDraft.optional(),
  /** What the user asked to change about this composition, oldest first; carried into the final images. */
  notes: z.array(z.string()).default([]),
});
export type Composition = z.infer<typeof Composition>;


/** A quick, cheap icon draft for one concept node, used to mock up compositions. */
export const Prototype = z.object({
  file: z.string(),
  /** The node visual it was drawn from, so a changed concept can be detected. */
  visual: z.string(),
  model: z.string(),
  ms: z.number().optional(),
  cost: z.number().nullable().optional(),
});
export type Prototype = z.infer<typeof Prototype>;

export const CompositionResult = z.object({
  options: z.array(Composition.omit({ draft: true, notes: true })).min(2).max(4),
});

export const aspectValue = (a: AspectRatio) => {
  const [w, h] = a.split(":").map(Number);
  return w / h;
};

/** Wireframe of a composition: boxes, labels, panels and edges. Shared by the UI preview and the image-model layout guide. */
export function compositionSvg(
  c: Composition,
  g: ConceptGraph,
  opts: { width?: number; guide?: boolean; /** nodeRef → image href (URL or data URI) drawn inside its box */ images?: Record<string, string> } = {},
): string {
  const W = opts.width ?? 1200;
  const H = Math.round(W / aspectValue(c.aspectRatio));
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const box = new Map(c.items.map((i) => [i.nodeRef, i]));
  const color = { focal: "#e8590c", primary: "#3b5bdb", secondary: "#868e96" } as const;
  const fs = Math.round(W / 55);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${fs / 2}" markerHeight="${fs / 2}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10z" fill="#495057"/></marker></defs>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ];
  for (const p of c.panels) {
    out.push(
      `<rect x="${p.x * W}" y="${p.y * H}" width="${p.w * W}" height="${p.h * H}" rx="${fs / 2}" fill="#f8f9fa" stroke="#adb5bd" stroke-dasharray="${fs / 2} ${fs / 3}"/>`,
      `<text x="${p.x * W + fs / 2}" y="${p.y * H + fs * 1.2}" font-size="${fs}" font-weight="700" fill="#495057">${esc(p.label)}</text>`,
    );
  }
  const centre = (i: CompositionItem) => ({ x: (i.x + i.w / 2) * W, y: (i.y + i.h / 2) * H });
  // Clip a centre-to-centre segment to the box edge so arrows start and end at the boxes.
  const edgePoint = (i: CompositionItem, toward: { x: number; y: number }) => {
    const c0 = centre(i);
    const dx = toward.x - c0.x, dy = toward.y - c0.y;
    const sx = (i.w * W) / 2 / Math.abs(dx || 1e-9), sy = (i.h * H) / 2 / Math.abs(dy || 1e-9);
    const t = Math.min(sx, sy, 1);
    return { x: c0.x + dx * t, y: c0.y + dy * t };
  };
  for (const e of g.edges) {
    const a = box.get(e.from), b = box.get(e.to);
    if (!a || !b) continue;
    const p = edgePoint(a, centre(b)), q = edgePoint(b, centre(a));
    out.push(
      `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#495057" stroke-width="${fs / 6}"${e.style === "dashed" ? ` stroke-dasharray="${fs / 2} ${fs / 3}"` : ""}${e.style !== "line" ? ' marker-end="url(#ah)"' : ""}/>`,
    );
  }
  for (const i of c.items) {
    const n = g.nodes.find((x) => x.id === i.nodeRef);
    const col = color[i.emphasis];
    const [x, y, w, h] = [i.x * W, i.y * H, i.w * W, i.h * H];
    const img = opts.images?.[i.nodeRef];
    out.push(
      img
        ? `<image href="${esc(img)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>` +
            (opts.guide ? "" : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${fs / 3}" fill="none" stroke="${col}" stroke-opacity="0.6" stroke-width="${i.emphasis === "focal" ? fs / 5 : fs / 12}"/>`)
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${fs / 3}" fill="${col}" fill-opacity="${opts.guide ? 0.08 : 0.12}" stroke="${col}" stroke-width="${i.emphasis === "focal" ? fs / 4 : fs / 8}"/>`,
      `<text x="${x + w / 2}" y="${y + h + fs * 1.1}" font-size="${fs}" text-anchor="middle" fill="#212529">${esc(n?.label ?? i.nodeRef)}</text>`,
    );
  }
  out.push("</svg>");
  return out.join("");
}

// ---------- Stage 4: candidates ----------

export const Candidate = z.object({
  id: z.string(),
  file: z.string(),
  model: z.string(),
  prompt: z.string(),
  /** Candidate this one was re-rendered from (draft → final). */
  referenceId: z.string().nullable().optional(),
  ms: z.number().optional(),
  cost: z.number().nullable().optional(),
});
export type Candidate = z.infer<typeof Candidate>;

// ---------- Stage 5: decompose ----------

/** Normalized (0..1) bounding box relative to the source image. */
export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBox>;

export const ComponentRole = z.enum(["icon", "container", "decoration"]);

export const DecomposedComponent = z.object({
  id: z.string(),
  nodeRef: z.string().nullable().describe("ConceptGraph node id this visual belongs to, or null"),
  role: ComponentRole,
  description: z.string().describe("What this visual element depicts"),
  bbox: BBox.describe("Tight box around the visual ONLY (exclude its text label and arrows), normalized 0..1"),
  labelBox: BBox.nullable().optional().describe("Box around this node's text label in the image, if any"),
});
export type DecomposedComponent = z.infer<typeof DecomposedComponent>;

export const DecomposeResult = z.object({
  components: z.array(DecomposedComponent),
});

export const Component = DecomposedComponent.extend({
  include: z.boolean().default(true),
  crop: z.string().optional(),
  regen: z.string().optional(),
  svg: z.string().optional(),
  status: z.enum(["pending", "working", "done", "error"]).default("pending"),
  error: z.string().optional(),
  /** Where the crop came from: a padded rectangle, or pixels isolated from model-split layers. */
  source: z.enum(["crop", "layers"]).default("crop"),
  /** How closely the SVG reproduces the original pixels (0..1), when traced. */
  fidelity: z.number().optional(),
  /** How the SVG was traced: filled shapes (vtracer) or stroked centrelines (thin-line art). */
  traceMethod: z.enum(["fill", "centerline"]).optional(),
});
export type Component = z.infer<typeof Component>;

/** A built component asset is an SVG, or the original pixels (PNG) when vectorizing wasn't faithful or wasn't wanted. */
export const isVectorAsset = (path: string | undefined) => !!path && path.toLowerCase().endsWith(".svg");

/**
 * How the picked image becomes components: keep each model-split layer whole (no decomposition),
 * regroup layer pixels per concept node, or crop rectangles per node.
 */
export const SplitMode = z.enum(["whole", "layers", "boxes"]);
export type SplitMode = z.infer<typeof SplitMode>;

/** Text read from the picked image, re-created as native editable text instead of being traced. */
export const ImageText = z.object({
  text: z.string().describe("Exact text, with \\n between lines"),
  bbox: BBox.describe("Tight box around the text, normalized 0..1"),
  lines: z.number().int().min(1).default(1),
  color: z.string().describe("Hex text colour"),
  bold: z.boolean().default(false),
  align: z.enum(["left", "center", "right"]).default("center"),
});
export type ImageText = z.infer<typeof ImageText>;

export const LayerReading = z.object({
  layers: z.array(
    z.object({
      index: z.number().int().describe("Layer number as shown on the sheet"),
      name: z.string().describe("Short name for what the layer contains, e.g. 'pipes', 'compressor'"),
      kind: z
        .enum(["text", "art", "connector", "background"])
        .describe("text: only lettering/numbers; connector: arrows, lines, pipes; background: plain fill; art: everything else"),
    }),
  ),
  texts: z.array(ImageText).describe("Every piece of text in the full image, one item per separate text block"),
});
export type LayerReading = z.infer<typeof LayerReading>;

// ---------- Stage 6: scene ----------

export const SceneNode = z.object({
  id: z.string(),
  componentId: z.string(),
  nodeRef: z.string().nullable(),
  svg: z.string().describe("asset path: an SVG, or a PNG of the original pixels"),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  label: z
    .object({ text: z.string(), x: z.number(), y: z.number(), fontSize: z.number(), color: z.string() })
    .nullable(),
});
export type SceneNode = z.infer<typeof SceneNode>;

export const SceneEdge = z.object({
  id: z.string(),
  from: z.string().describe("SceneNode id"),
  to: z.string(),
  label: z.string().optional(),
  style: z.enum(["arrow", "line", "dashed"]),
  color: z.string(),
});
export type SceneEdge = z.infer<typeof SceneEdge>;

export const SceneText = z.object({
  id: z.string(),
  text: z.string(),
  /** Top-left of the text box in canvas pixels. */
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  fontSize: z.number(),
  color: z.string(),
  bold: z.boolean(),
  align: z.enum(["left", "center", "right"]),
});
export type SceneText = z.infer<typeof SceneText>;

export const Scene = z.object({
  width: z.number(),
  height: z.number(),
  background: z.string(),
  layout: z.enum(["original", "auto"]),
  nodes: z.array(SceneNode),
  edges: z.array(SceneEdge),
  /** Free text (not tied to a node), e.g. read from the image in "whole layers" mode. */
  texts: z.array(SceneText).default([]),
});
export type Scene = z.infer<typeof Scene>;

// ---------- usage ----------

export const UsageEvent = z.object({
  at: z.string(),
  stage: z.string(),
  kind: z.enum(["llm", "image"]),
  provider: z.string(),
  model: z.string(),
  ms: z.number(),
  /** USD as reported by the provider; null when unknown. */
  cost: z.number().nullable(),
  /** Candidate / component id the call produced, if any. */
  ref: z.string().optional(),
  ok: z.boolean().default(true),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

// ---------- Project ----------

export const Stage = z.enum(["clarify", "concept", "composition", "candidates", "decompose", "workspace"]);
export type Stage = z.infer<typeof Stage>;

export const Job = z.object({
  kind: z.string(),
  status: z.enum(["running", "done", "error"]),
  message: z.string().optional(),
  progress: z.number().optional(),
  error: z.string().optional(),
  /** ISO time the job started, so clients can show elapsed time across reloads. */
  startedAt: z.string().optional(),
});
export type Job = z.infer<typeof Job>;

// ---------- visual style presets ----------

export interface StylePreset {
  id: string;
  label: string;
  blurb: string;
  /** Guidance for the concept stage: tone, palette, how literal, how many elements. */
  concept: string;
  /** Style paragraph for full-diagram image prompts. */
  image: string;
  /** Style paragraph for regenerating a single component icon. */
  icon: string;
}

// Every preset stays flat-filled on white so components can still be cut out and traced.
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "flat",
    label: "Clean flat",
    blurb: "Modern flat vector, friendly but professional",
    concept: "General audience. Clean modern flat illustration. Palette: 3-5 harmonious, moderately saturated colors plus a dark neutral.",
    image: "Modern flat 2D vector illustration: solid fills, simple geometric shapes with slightly rounded corners, consistent medium line weight, no gradients, no shadows, no textures. Short, legible sans-serif labels.",
    icon: "Modern flat 2D vector icon: solid fills, simple geometric shapes, slightly rounded corners, consistent medium line weight.",
  },
  {
    id: "scientific",
    label: "Scientific / journal",
    blurb: "Publication figure, like Nature or Cell schematics",
    concept: "Expert audience reading a journal figure. Precise and literal, never cartoonish or metaphorical; use correct technical depictions and terminology. Palette: restrained and muted (desaturated blues, slate greys, at most one warm accent) plus near-black #222222 for strokes and text; colorblind-safe.",
    image: "Scientific journal figure in the style of a Nature / Cell / Science schematic: clean precise vector drawing, thin uniform dark-grey strokes (about 1-1.5 pt), flat muted fills, simple geometric and anatomically/technically accurate shapes, strict alignment, generous whitespace. No cartoon faces, no decoration, no gradients, no shadows. Small labels in Helvetica/Arial.",
    icon: "Scientific schematic drawing in journal-figure style: thin uniform dark-grey outline, flat muted fills, precise and technically accurate, no cartoon features.",
  },
  {
    id: "textbook",
    label: "Textbook",
    blurb: "Clear educational illustration for students",
    concept: "Students learning the topic for the first time. Literal, clear depictions; cutaway or simplified views where they explain the mechanism. Palette: clear, moderately saturated, distinguishable colors plus a dark outline color.",
    image: "Educational textbook illustration: clear dark outlines of medium weight, flat solid fills in clear distinguishable colors, simplified but accurate depictions, tidy arrangement, no gradients, no shadows. Clean sans-serif labels.",
    icon: "Educational textbook illustration: clear medium-weight dark outline, flat solid fills, simplified but accurate.",
  },
  {
    id: "kids",
    label: "Kids / picture book",
    blurb: "Bold, bright and playful, with friendly characters",
    concept: "Young children (6-10). Use simple everyday words, friendly analogies and characters; keep to 3-6 elements. Objects may have cute faces where it helps. Palette: bright cheerful saturated colors (sunny yellow, sky blue, grass green, coral) plus a thick dark outline color.",
    image: "Playful children's picture-book illustration: big chunky rounded shapes, thick dark outlines, bright cheerful saturated flat colors, friendly cute faces on characters and objects, very simple with minimal detail, no gradients, no shadows, no textures. Labels in big rounded friendly lettering.",
    icon: "Playful children's picture-book character/object: big rounded chunky shape, thick dark outline, bright cheerful flat colors, friendly and cute, minimal detail.",
  },
  {
    id: "whiteboard",
    label: "Whiteboard sketch",
    blurb: "Hand-drawn marker sketch, like a talk or lecture",
    concept: "Informal explanation, like someone sketching on a whiteboard while talking. Simple, iconic doodles. Palette: black marker #1a1a1a plus 1-2 accent marker colors (e.g. blue, red).",
    image: "Hand-drawn whiteboard marker sketch on a plain white background: confident black marker line drawings, simple doodle icons, one or two accent marker colors used sparingly as flat fills, slightly imperfect hand-drawn lines, handwritten-style labels. No gradients, no shadows, no paper texture.",
    icon: "Hand-drawn black marker doodle with one accent color fill, confident simple lines, slightly imperfect.",
  },
  {
    id: "tech",
    label: "Tech / isometric",
    blurb: "Isometric icons, like cloud architecture diagrams",
    concept: "Engineers and technical readers. Systems shown as distinct components (servers, services, devices, data stores). Palette: cool blues, teals and a violet accent plus dark slate.",
    image: "Technical architecture diagram with isometric flat icons: crisp 30-degree isometric objects with 2-3 flat tones per face for depth, cool blues/teals/violet, clean and modern, no gradients, no drop shadows. Clean monospace or sans-serif labels.",
    icon: "Isometric flat tech icon: crisp 30-degree isometric object, 2-3 flat tones per face, cool blues/teals/violet, no gradients.",
  },
  {
    id: "line",
    label: "Minimal line",
    blurb: "Monoline icons, editorial and presentation-ready",
    concept: "Professional audience; elegant, minimal and calm. Palette: one dark ink color plus one or two accent colors used sparingly.",
    image: "Minimal monoline illustration: single consistent stroke weight outline icons in a dark ink color, very sparse flat accent fills in one or two colors, lots of whitespace, elegant editorial look, no gradients, no shadows. Light sans-serif labels.",
    icon: "Minimal monoline outline icon: single consistent stroke weight, dark ink, one sparse flat accent fill.",
  },
];

export const stylePreset = (id: string | undefined) => STYLE_PRESETS.find((s) => s.id === id) ?? STYLE_PRESETS[0];

export const Project = z.object({
  id: z.string(),
  topic: z.string(),
  stylePreset: z.string().default("flat"),
  /** Free-text style direction layered on top of the preset. */
  styleNotes: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  stage: Stage,
  clarify: z.array(ClarifyRound).default([]),
  concept: ConceptGraph.nullable().default(null),
  conceptApproved: z.boolean().default(false),
  conceptHistory: z.array(z.object({ feedback: z.string() })).default([]),
  compositions: z.array(Composition).default([]),
  /** Quick icon drafts per concept node (Recraft flash), for mocking up compositions. */
  prototypes: z.record(z.string(), Prototype).default({}),
  /** The chosen (and possibly hand-adjusted) composition that drives image generation. */
  composition: Composition.nullable().default(null),
  candidates: z.array(Candidate).default([]),
  pickedCandidate: z.string().nullable().default(null),
  components: z.array(Component).default([]),
  /** How the picked image was split. */
  split: SplitMode.default("boxes"),
  /** Text read from the picked image (whole-layer mode). */
  texts: z.array(ImageText).default([]),
  scene: Scene.nullable().default(null),
  /** Fabric.js JSON once the user has edited the workspace. */
  workspace: z.unknown().nullable().default(null),
  job: Job.nullable().default(null),
  usage: z.array(UsageEvent).default([]),
});
export type Project = z.infer<typeof Project>;

export const STAGES: Stage[] = Stage.options;
