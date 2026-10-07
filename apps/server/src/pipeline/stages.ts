import sharp from "sharp";
import {
  ClarifyResult,
  Composition,
  CompositionResult,
  ConceptGraph,
  DecomposeResult,
  LayerReading,
  compositionSvg,
  isVectorAsset,
  type SplitMode,
  type Component,
  type Project,
} from "@diagram/core";
import { generateImages, type ImageOut } from "../images/index.js";
import { config, scrubError } from "../lib/config.js";
import { load, newId, readAsset, update, writeAsset } from "../lib/store.js";
import { layoutAuto, layoutOriginal } from "../layout/index.js";
import { llmJson } from "../llm/index.js";
import {
  CLARIFY_SYSTEM,
  COMPOSITION_SYSTEM,
  CONCEPT_SYSTEM,
  DECOMPOSE_SYSTEM,
  DRAFT_GUIDE_NOTE,
  compositionDraftPrompt,
  LAYERS_SYSTEM,
  layersUserMessage,
  LAYOUT_GUIDE_NOTE,
  prototypePrompt,
  candidatePrompt,
  clarifyUserMessage,
  compositionUserMessage,
  conceptUserMessage,
  regenPrompt,
} from "../llm/prompts.js";
import { crop, imageSize, removeBackground } from "../vector/raster.js";
import { boundObjects, isolateComponents, layerSheet, snapTextBoxes, trimLayers } from "../vector/layers.js";
import { inkColor, matchTexts, ocrEnabled, ocrImage } from "../vector/ocr.js";
import { stripText } from "../vector/inpaint.js";
import { withStage } from "../lib/usage.js";
import { finalizeSvg, traceImage, vectorize } from "../vector/vtracer.js";

const MAX_CLARIFY_ROUNDS = 2;

// ---------- job runner ----------

/**
 * Run a long stage in the background, mirroring its status into `project.job` (streamed over SSE).
 * Resolves once the job is marked running, so clients never observe the previous job's state.
 */
export async function runJob(id: string, kind: string, fn: (progress: (message: string, progress?: number) => Promise<void>) => Promise<void>) {
  const startedAt = new Date().toISOString();
  const progress = (message: string, p?: number) =>
    update(id, (proj) => {
      proj.job = { kind, status: "running", message, progress: p, startedAt };
    }).then(() => {});
  await progress("Starting…", 0);
  void (async () => {
    try {
      await withStage(id, kind, () => fn(progress));
      await update(id, (proj) => {
        proj.job = { kind, status: "done" };
      });
    } catch (err) {
      const safe = scrubError(err);
      console.error(`[job ${kind}]`, safe);
      await update(id, (proj) => {
        proj.job = { kind, status: "error", error: safe.message };
      });
    }
  })();
}

// ---------- 1. clarify ----------

export async function clarify(id: string) {
  const p = await load(id);
  const res = await llmJson({
    name: "clarify",
    // The first analysis is the core synthesis; follow-up rounds are lighter orchestration.
    tier: p.clarify.length === 0 ? "synthesis" : "general",
    description: "Return a first-principles analysis of the concept and clarifying questions.",
    system: CLARIFY_SYSTEM,
    messages: [{ role: "user", content: clarifyUserMessage(p.topic, p.clarify, p) }],
    schema: ClarifyResult,
  });
  const rounds = p.clarify.length + 1;
  // Stop asking once the model is satisfied or we've hit the round limit.
  const done = res.questions.length === 0 || rounds > MAX_CLARIFY_ROUNDS;
  await update(id, (proj) => {
    proj.clarify.push({ analysis: res.analysis, questions: done ? [] : res.questions });
  });
  if (done) await concept(id);
}

export async function answer(id: string, answers: Record<string, string>) {
  await update(id, (p) => {
    const last = p.clarify.at(-1);
    if (!last) throw new Error("no open questions");
    last.answers = answers;
  });
  const rounds = (await load(id)).clarify.length;
  try {
    await clarify(id);
  } catch (err) {
    // The follow-up call failed before producing a new round: reopen the questions so they can be resubmitted.
    await update(id, (p) => {
      if (p.clarify.length === rounds) delete p.clarify.at(-1)!.answers;
    });
    throw err;
  }
}

// ---------- 2. concept ----------

export async function concept(id: string, feedback?: string) {
  return withStage(id, "concept", () => conceptInner(id, feedback));
}

async function conceptInner(id: string, feedback?: string) {
  const p = await load(id);
  const graph = await llmJson({
    name: "concept",
    tier: "synthesis",
    description: "Return the diagram concept: prose for the user plus a structured graph.",
    system: CONCEPT_SYSTEM,
    messages: [{ role: "user", content: conceptUserMessage(p.topic, p.clarify, p, p.concept, feedback) }],
    schema: ConceptGraph,
  });
  await update(id, (proj) => {
    proj.concept = graph;
    proj.conceptApproved = false;
    if (feedback) proj.conceptHistory.push({ feedback });
    proj.stage = "concept";
  });
}

export async function approveConcept(id: string) {
  return update(id, (p) => {
    if (!p.concept) throw new Error("no concept to approve");
    p.conceptApproved = true;
    p.stage = "composition";
  });
}

// ---------- 3. composition ----------

/** Keep only boxes for real nodes, clamp them into the frame, and add any node the model forgot. */
function normalizeComposition(c: Composition, g: ConceptGraph): Composition {
  const ids = new Set(g.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const items = c.items
    .filter((i) => ids.has(i.nodeRef) && !seen.has(i.nodeRef) && seen.add(i.nodeRef))
    .map((i) => {
      const w = Math.min(i.w, 0.98), h = Math.min(i.h, 0.95);
      return { ...i, w, h, x: Math.min(Math.max(i.x, 0), 1 - w), y: Math.min(Math.max(i.y, 0), 1 - h) };
    });
  const missing = g.nodes.filter((n) => !seen.has(n.id));
  missing.forEach((n, k) => {
    const w = Math.min(0.15, 0.9 / missing.length - 0.03);
    items.push({ nodeRef: n.id, x: 0.05 + k * (w + 0.03), y: 0.78, w, h: 0.12, emphasis: "secondary" });
  });
  return { ...c, items };
}

/** Draw quick icon drafts for nodes (all stale/missing ones, or the given ids) with the draft model. */
export async function prototypes(id: string, opts: { nodeIds?: string[]; feedback?: string } = {}, progress?: (m: string) => Promise<void>) {
  const p = await load(id);
  const g = p.concept;
  if (!g) throw new Error("no concept");
  const todo = opts.nodeIds
    ? g.nodes.filter((n) => opts.nodeIds!.includes(n.id))
    : g.nodes.filter((n) => p.prototypes[n.id]?.visual !== n.visual);
  if (!todo.length) return;
  let done = 0;
  await progress?.(`Sketching ${todo.length} element${todo.length === 1 ? "" : "s"} with ${config.draftModel}…`);
  const results = await Promise.allSettled(
    todo.map(async (n) => {
      const [img] = await generateImages({
        prompt: prototypePrompt(n.visual, g, p, opts.feedback),
        model: config.draftModel,
        n: 1,
        aspectRatio: "1:1",
        ref: n.id,
        context: { kind: "prototype", node: n, graph: g },
      });
      const png = await removeBackground(await toPng(img));
      const file = await writeAsset(id, `prototypes/${n.id}-${Date.now().toString(36)}.png`, png);
      await update(id, (proj) => {
        proj.prototypes[n.id] = { file, visual: n.visual, model: config.draftModel, ms: img.ms, cost: img.cost ?? null };
      });
      await progress?.(`Sketched ${++done} of ${todo.length} elements`);
    }),
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === results.length) throw failed[0].reason;
}

/** Composition options, each drawn as one whole-figure draft so they can be judged as diagrams. */
export async function composeAndDraw(id: string, feedback: string | undefined, progress: (m: string) => Promise<void>) {
  await progress("Planning composition options…");
  await compose(id, feedback);
  const p = await load(id);
  await progress(`Drawing ${p.compositions.length} whole-figure drafts with ${config.compositionDraftModel}…`);
  let done = 0;
  const results = await Promise.allSettled(
    p.compositions.map(async (c) => {
      await drawComposition(id, c.id);
      await progress(`Drew ${++done} of ${p.compositions.length} drafts`);
    }),
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) await progress(`${failed.length} draft${failed.length > 1 ? "s" : ""} failed: ${String(failed[0].reason).slice(0, 200)} — its layout is shown as boxes.`);
}

/** Draw (or redraw, with the user's comments) the whole figure for one composition option. */
export async function drawComposition(id: string, compositionId: string, feedback?: string) {
  const p = await load(id);
  const g = p.concept;
  const c = p.compositions.find((x) => x.id === compositionId);
  if (!g || !c) throw new Error("unknown composition");
  const note = feedback?.trim();
  const target = note ? { ...c, notes: [...c.notes, note] } : c;
  const model = config.compositionDraftModel;
  const [img] = await generateImages({
    prompt: compositionDraftPrompt(target, g, p),
    model,
    n: 1,
    aspectRatio: c.aspectRatio,
    quality: "low",
    // Redraws build on the previous draft when the model takes references.
    references: note && c.draft ? [await readAsset(id, c.draft.file)] : undefined,
    ref: c.id,
    context: { kind: "candidate", graph: g, variant: p.compositions.indexOf(c) },
  });
  const file = await writeAsset(id, `compositions/${c.id}-${Date.now().toString(36)}.png`, await toPng(img));
  await update(id, (proj) => {
    const x = proj.compositions.find((y) => y.id === compositionId);
    if (!x) return;
    x.draft = { file, model, ms: img.ms, cost: img.cost ?? null };
    if (note) x.notes = target.notes;
  });
}

export async function compose(id: string, feedback?: string) {
  const p = await load(id);
  if (!p.concept) throw new Error("no concept");
  const g = p.concept;
  const res = await llmJson({
    name: "composition",
    description: "Return 2-4 distinct composition options for the figure.",
    system: COMPOSITION_SYSTEM,
    messages: [{ role: "user", content: compositionUserMessage(g, p, p.compositions, feedback) }],
    schema: CompositionResult,
    context: g,
  });
  await update(id, (proj) => {
    proj.compositions = res.options.map((c, i) => normalizeComposition({ ...c, notes: [], id: `${c.id || "option"}-${i + 1}` }, g));
    proj.stage = "composition";
  });
}

/** Save the chosen (possibly hand-adjusted) composition and move on to image generation. */
export async function chooseComposition(id: string, composition: unknown) {
  const c = Composition.parse(composition);
  return update(id, (p) => {
    if (!p.concept) throw new Error("no concept");
    // Hand-moved boxes no longer match the drawn draft: the box mock-up guides the images instead.
    const stored = p.compositions.find((x) => x.id === c.id);
    const same = stored && JSON.stringify([stored.items, stored.aspectRatio]) === JSON.stringify([c.items, c.aspectRatio]);
    p.composition = normalizeComposition({ ...c, draft: same ? stored.draft : undefined, notes: stored?.notes ?? c.notes }, p.concept);
    p.stage = "candidates";
  });
}

// ---------- 3. candidates ----------

async function toPng(img: ImageOut): Promise<Buffer> {
  return img.mediaType === "image/png" ? img.data : sharp(img.data).png().toBuffer();
}

export interface CandidateOptions {
  /** One or more models; each renders `n` images in parallel so they can be compared. */
  models?: string[];
  n?: number;
  feedback?: string;
  /** Re-render from an existing candidate (e.g. a cheap draft) as the reference image. */
  referenceId?: string;
  /** Send the chosen composition's wireframe as a layout reference (models that accept references). Default true. */
  layoutGuide?: boolean;
}

export async function candidates(id: string, opts: CandidateOptions, progress: (m: string) => Promise<void>) {
  const p = await load(id);
  if (!p.concept) throw new Error("no concept");
  const models = opts.models?.length ? opts.models : [config.candidateModel];
  const n = opts.n ?? 2;
  const ref = opts.referenceId ? p.candidates.find((c) => c.id === opts.referenceId) : undefined;
  const refPng = ref ? await readAsset(id, ref.file) : undefined;
  const comp = p.composition;
  const useGuide = !ref && comp && opts.layoutGuide !== false;
  // Prefer the approved whole-figure draft; fall back to the box mock-up.
  const draftPng = useGuide && comp.draft ? await readAsset(id, comp.draft.file).catch(() => undefined) : undefined;
  const guide = useGuide ? (draftPng ?? (await mockup(p, comp))) : undefined;
  const base = candidatePrompt(p.concept, p, opts.feedback, comp);
  const prompt = ref
    ? `Re-render this diagram draft as a polished final illustration. Keep its composition, elements and layout; improve clarity, line quality and consistency.\n\n${base}`
    : guide
      ? `${draftPng ? DRAFT_GUIDE_NOTE : LAYOUT_GUIDE_NOTE}\n\n${base}`
      : base;
  const references = refPng ? [refPng] : guide ? [guide] : undefined;
  const total = n * models.length;
  await progress(`Generating ${total} image${total === 1 ? "" : "s"} with ${models.join(", ")} — drafts take seconds, final models up to a minute each…`);
  let done = 0;
  const jobs = models.flatMap((model) =>
    Array.from({ length: n }, (_, i) => async () => {
      const cid = newId();
      const [img] = await generateImages({
        prompt,
        model,
        n: 1,
        aspectRatio: comp?.aspectRatio ?? "3:2",
        quality: "medium",
        references,
        ref: cid,
        context: { kind: "candidate", graph: p.concept, variant: p.candidates.length + i + models.indexOf(model) * n },
      }).catch(async (err) => {
        await progress(`${model} failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        throw err;
      });
      const file = await writeAsset(id, `candidates/${cid}.png`, await toPng(img));
      await update(id, (proj) => {
        proj.candidates.push({ id: cid, file, model, prompt, referenceId: ref?.id ?? null, ms: img.ms, cost: img.cost ?? null });
      });
      await progress(`${++done} of ${total} images done${done < total ? " — waiting on the rest…" : ""}`);
    }),
  );
  const results = await Promise.allSettled(jobs.map((j) => j()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length === results.length) throw failed[0].reason;
  if (failed.length) await progress(`${failed.length} of ${total} images failed: ${String(failed[0].reason).slice(0, 200)}`);
}

/** The composition rendered with its element sketches, as a PNG layout reference. */
async function mockup(p: Project, comp: Composition): Promise<Buffer> {
  const images: Record<string, string> = {};
  for (const [nodeRef, proto] of Object.entries(p.prototypes)) {
    const png = await readAsset(p.id, proto.file).catch(() => null);
    if (png) images[nodeRef] = `data:image/png;base64,${png.toString("base64")}`;
  }
  return sharp(Buffer.from(compositionSvg(comp, p.concept!, { width: 1200, guide: true, images }))).png().toBuffer();
}

// ---------- 4. decompose ----------

export type { SplitMode };

export async function pick(id: string, candidateId: string, split: SplitMode, progress: (m: string) => Promise<void>) {
  const p = await update(id, (proj) => {
    if (!proj.candidates.some((c) => c.id === candidateId)) throw new Error("unknown candidate");
    proj.pickedCandidate = candidateId;
    proj.stage = "decompose";
    proj.split = split;
    proj.components = [];
    proj.texts = [];
    proj.scene = null;
    proj.workspace = null;
  });
  if (split === "whole") return pickWhole(p, candidateId, progress);
  await progress(
    split === "layers"
      ? "Finding components with the vision model and splitting into layers (≈60–90s)…"
      : "Finding components with the vision model (≈20–40s)…",
  );
  const cand = p.candidates.find((c) => c.id === candidateId)!;
  const full = await readAsset(id, cand.file);
  const preview = await sharp(full).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  // The vision model gives semantics (which node is where); the layer model gives clean pixels.
  let pending = split === "layers" ? 2 : 1;
  const [res, layers] = await Promise.all([
    llmJson({
      name: "decompose",
      // Box precision matters downstream; the stronger model clipped far less in side-by-side tests.
      tier: "synthesis",
      description: "Return the visual components of the diagram with normalized bounding boxes.",
      system: DECOMPOSE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: preview, mediaType: "image/png" },
            { type: "text", text: `Concept graph:\n${JSON.stringify(p.concept, null, 2)}` },
          ],
        },
      ],
      schema: DecomposeResult,
      context: p.concept,
    }).then(async (r) => {
      if (--pending) await progress(`Found ${r.components.length} components — still splitting into layers…`);
      return r;
    }),
    split === "layers"
      ? splitLayers(id, full).then(async (l) => {
          if (--pending) await progress(`Split into ${l.length} layers — still finding components…`);
          return l;
        })
      : Promise.resolve(null),
  ]);
  await progress(layers ? `Isolating ${res.components.length} components from ${layers.length} layers…` : `Cropping ${res.components.length} components…`);
  const isolated = layers ? await isolateComponents(layers, res.components) : new Map();
  const comps: Component[] = [];
  for (const c of res.components) {
    const iso = isolated.get(c.id);
    const png = iso ? iso.png : (await crop(full, c.bbox, 0.06)).png;
    const file = await writeAsset(id, `crops/${c.id}.png`, png);
    if (!iso) await progress(`Cropped ${comps.length + 1} of ${res.components.length} components…`);
    comps.push({ ...c, bbox: iso?.bbox ?? c.bbox, include: true, crop: file, status: "pending", source: iso ? "layers" : "crop" });
  }
  await update(id, (proj) => {
    proj.components = comps;
  });
  if (layers) await progress(`Isolated ${isolated.size} of ${comps.length} components from ${layers.length} layers`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "layer";

/**
 * No decomposition: every layer from the layer model becomes one component, kept where it sits.
 * A vision call names the layers and reads the text, which is re-created as editable text
 * instead of being traced.
 */
async function pickWhole(p: Project, candidateId: string, progress: (m: string) => Promise<void>) {
  const id = p.id;
  const full = await readAsset(id, p.candidates.find((c) => c.id === candidateId)!.file);
  await progress("Splitting the image into layers (≈40–70s)…");
  const layers = await trimLayers(await splitLayers(id, full));
  if (!layers.length) throw new Error("the layer model returned no layers");
  await progress(`Split into ${layers.length} layers — naming them and reading the text…`);
  const size = await imageSize(full);
  const preview = await sharp(full).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const reading = await llmJson({
    name: "layers",
    // Text boxes need the stronger model's precision.
    tier: "synthesis",
    description: "Name each layer and read all text in the image.",
    system: LAYERS_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Full image:" },
          { type: "image", data: preview, mediaType: "image/png" },
          { type: "text", text: "Layer sheet:" },
          { type: "image", data: await layerSheet(layers, size), mediaType: "image/png" },
          { type: "text", text: layersUserMessage(p.concept, layers.map((l) => l.index)) },
        ],
      },
    ],
    schema: LayerReading,
    context: { layers: layers.map((l) => ({ index: l.index, coverage: l.coverage })), graph: p.concept },
  });
  const info = new Map(reading.layers.map((l) => [l.index, l]));
  const kindOf = (l: (typeof layers)[number]) => info.get(l.index)?.kind ?? (l.coverage > 0.6 ? "background" : "art");
  const textLayers = layers.filter((l) => kindOf(l) === "text").map((l) => l.index);
  const rawLayers = await Promise.all(textLayers.map((i) => readAsset(id, `layers/layer-${i}.png`)));
  let texts = await snapTextBoxes(rawLayers, reading.texts.filter((t) => t.text.trim()));
  // OCR gives exact geometry; the model's spelling and wording are kept. Any failure keeps the snapped boxes.
  if (ocrEnabled()) {
    try {
      await progress("Measuring text boxes with OCR…");
      const ocr = await ocrImage(full);
      if (ocr) {
        const boxes = matchTexts(texts, ocr);
        texts = await Promise.all(
          texts.map(async (t, i) => {
            const box = boxes[i];
            if (!box) return t;
            return { ...t, bbox: box, color: (await inkColor(full, box).catch(() => null)) ?? t.color };
          }),
        );
        await progress(`OCR matched ${boxes.filter(Boolean).length} of ${texts.length} text boxes`);
      } else await progress("OCR unavailable — using estimated text boxes");
    } catch {
      await progress("OCR failed — using estimated text boxes");
    }
  }

  const used = new Set<string>();
  const comps: Component[] = [];
  // Layer models list top-most first; components are stored back to front (canvas paint order).
  for (const l of [...layers].reverse()) {
    const kind = kindOf(l);
    const name = info.get(l.index)?.name ?? `Layer ${l.index}`;
    // Bound first: separate objects on one layer (four panels' plots, step badges) become separate components.
    let layer = l;
    if ((kind === "art" || kind === "connector") && texts.length) {
      // Lettering baked into art would double the editable text: erase it and fill the hole first.
      try {
        const r = await stripText(l.png, l.bbox, l.frame, texts.map((t) => ({ bbox: t.bbox, color: t.color })));
        if (r.removed) {
          layer = { ...l, png: r.png };
          await progress(`Removed baked-in text from "${name}"`);
        }
      } catch {
        // keep the layer as it was
      }
    }
    const parts = kind === "art" || kind === "connector" ? await boundObjects(layer) : [{ png: l.png, bbox: l.bbox }];
    for (const [k, part] of parts.entries()) {
      let cid = slug(name) + (parts.length > 1 ? `-${k + 1}` : "");
      while (used.has(cid)) cid += `-${l.index}`;
      used.add(cid);
      comps.push({
        id: cid,
        nodeRef: null,
        role: kind === "background" ? "container" : kind === "art" ? "icon" : "decoration",
        description: kind === "text" ? `${name} (re-created as editable text)` : parts.length > 1 ? `${name} — part ${k + 1} of ${parts.length}` : name,
        bbox: part.bbox,
        // Text is re-typed and a plain background becomes the canvas colour; both can be traced on demand.
        include: kind === "art" || kind === "connector",
        crop: await writeAsset(id, `crops/${cid}.png`, part.png),
        status: "pending",
        source: "layers",
      });
    }
  }
  await update(id, (proj) => {
    proj.components = comps;
    proj.texts = texts;
  });
  await progress(`Kept ${comps.filter((c) => c.include).length} layers as components · ${texts.length} text items will be editable text`);
}

async function splitLayers(id: string, full: Buffer): Promise<Buffer[]> {
  const out = await generateImages({
    prompt: "Decompose this diagram into separate layers: background, and each icon or element.",
    model: config.layerModel,
    references: [full],
    outputFormat: "png",
    ref: "layers",
    context: { kind: "layers" },
  });
  const pngs = await Promise.all(out.map(toPng));
  await Promise.all(pngs.map((png, i) => writeAsset(id, `layers/layer-${i}.png`, png)));
  return pngs;
}

export async function editComponents(id: string, edits: Pick<Component, "id" | "include" | "bbox" | "description">[]) {
  const p = await load(id);
  const cand = p.candidates.find((c) => c.id === p.pickedCandidate);
  const full = cand ? await readAsset(id, cand.file) : null;
  const crops: Record<string, string> = {};
  for (const e of edits) {
    const prev = p.components.find((c) => c.id === e.id);
    if (full && prev && JSON.stringify(prev.bbox) !== JSON.stringify(e.bbox)) {
      crops[e.id] = await writeAsset(id, `crops/${e.id}.png`, (await crop(full, e.bbox, 0.06)).png);
    }
  }
  return update(id, (proj) => {
    for (const e of edits) {
      const c = proj.components.find((x) => x.id === e.id);
      if (!c) continue;
      Object.assign(c, { include: e.include, bbox: e.bbox, description: e.description });
      if (crops[e.id]) Object.assign(c, { crop: crops[e.id], source: "crop" });
    }
  });
}

// ---------- 5+6. regenerate + vectorize ----------

/** Below this, a trace visibly drifts from the original (thicker/wobbly lines, colour bleed). */
export const MIN_FIDELITY = 0.95;

export interface BuildOptions {
  /** Regenerate each crop with the image model (else trace the crop directly). */
  regenerate: boolean;
  /** Skip vectorizing: place the original pixels. */
  keepOriginal?: boolean;
  /** Keep a trace only if it reproduces the original at least this well; else fall back to the original pixels. */
  minFidelity?: number;
  /** Use a native-SVG model (Recraft) instead of vtracer. */
  nativeSvg?: boolean;
  feedback?: string;
}

async function buildComponent(p: Project, c: Component, full: Buffer, opts: BuildOptions, step: (m: string) => Promise<void> = async () => {}) {
  const v = Date.now().toString(36);
  // Layer-isolated pixels are already clean and transparent; otherwise take a padded crop.
  const isolated = c.source === "layers" && c.crop ? await readAsset(p.id, c.crop) : null;
  const cropPng = isolated ?? (await crop(full, c.bbox, 0.08)).png;
  // Image models expect opaque references.
  const refPng = isolated ? await sharp(isolated).flatten({ background: "#ffffff" }).png().toBuffer() : cropPng;
  if (opts.keepOriginal) {
    // Original pixels, background-free and bounded to the element.
    const png = isolated ?? (await removeBackground(cropPng));
    return { regen: undefined, svg: await writeAsset(p.id, `raster/${c.id}-${v}.png`, png), fidelity: undefined, traceMethod: undefined };
  }
  const prompt = regenPrompt(c, p.concept!, p) + (opts.feedback ? `\nAlso: ${opts.feedback}` : "");
  let regen: string | undefined;
  let svg: string;
  let fidelity: number | undefined;
  let traceMethod: Component["traceMethod"];
  if (opts.nativeSvg) {
    await step("Generating SVG for");
    const [out] = await generateImages({
      prompt,
      model: config.vectorModel,
      references: [refPng],
      outputFormat: "svg",
      aspectRatio: "1:1",
      ref: c.id,
      context: { kind: "regen" },
    });
    svg = out.mediaType.includes("svg") ? finalizeSvg(out.data.toString("utf8")) : await vectorize(await toPng(out));
  } else {
    let source = cropPng;
    if (opts.regenerate) {
      await step("Regenerating");
      const [out] = await generateImages({
        prompt,
        model: config.regenModel,
        references: [refPng, full],
        background: "transparent",
        aspectRatio: "1:1",
        quality: "medium",
        ref: c.id,
        context: { kind: "regen" },
      });
      source = await toPng(out);
      regen = await writeAsset(p.id, `regen/${c.id}-${v}.png`, source);
    }
    await step("Vectorizing");
    const traced = await traceImage(source);
    fidelity = traced.fidelity;
    traceMethod = traced.method;
    // Only keep the vector when it's faithful; otherwise the original (bounded) pixels are better.
    if (opts.minFidelity != null && !opts.regenerate && traced.fidelity < opts.minFidelity) {
      return { regen, svg: await writeAsset(p.id, `raster/${c.id}-${v}.png`, traced.source), fidelity, traceMethod };
    }
    svg = traced.svg;
  }
  const file = await writeAsset(p.id, `svg/${c.id}-${v}.svg`, svg);
  return { regen, svg: file, fidelity, traceMethod };
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

export async function build(id: string, opts: BuildOptions, progress: (m: string, p?: number) => Promise<void>) {
  const p = await load(id);
  const cand = p.candidates.find((c) => c.id === p.pickedCandidate);
  if (!cand || !p.concept) throw new Error("pick a candidate first");
  const full = await readAsset(id, cand.file);
  const todo = p.components.filter((c) => c.include);
  const label = (c: Component) => p.concept!.nodes.find((n) => n.id === c.nodeRef)?.label ?? c.id;
  let done = 0;
  await progress(`Building ${todo.length} components${opts.regenerate || opts.nativeSvg ? " (≈15–40s each, 3 at a time)" : ""}…`, 0);
  await pool(todo, 3, async (c) => {
    await update(id, (proj) => {
      const x = proj.components.find((y) => y.id === c.id)!;
      x.status = "working";
      x.error = undefined;
    });
    try {
      const out = await buildComponent(p, c, full, opts, (m) =>
        progress(`${m} ${label(c)} (${todo.indexOf(c) + 1}/${todo.length}) — ${done} done`, done / todo.length),
      );
      await update(id, (proj) => {
        Object.assign(proj.components.find((y) => y.id === c.id)!, { ...out, status: "done" });
      });
    } catch (err) {
      await update(id, (proj) => {
        Object.assign(proj.components.find((y) => y.id === c.id)!, { status: "error", error: String(err) });
      });
    }
    await progress(`${++done} of ${todo.length} components built`, done / todo.length);
  });
  await progress("Arranging components into the workspace…", 1);
  await relayout(id, "original");
}

export async function rebuildComponent(id: string, componentId: string, opts: BuildOptions) {
  const p = await load(id);
  const cand = p.candidates.find((c) => c.id === p.pickedCandidate);
  const c = p.components.find((x) => x.id === componentId);
  if (!cand || !c || !p.concept) throw new Error("unknown component");
  const out = await buildComponent(p, c, await readAsset(id, cand.file), opts);
  await update(id, (proj) => {
    Object.assign(proj.components.find((y) => y.id === componentId)!, { ...out, status: "done", include: true });
    // Swap the asset in place so the user's arrangement is kept.
    const node = proj.scene?.nodes.find((n) => n.componentId === componentId);
    if (node) node.svg = out.svg;
  });
  return out;
}

// ---------- 7. layout ----------

export async function relayout(id: string, mode: "original" | "auto") {
  const p = await load(id);
  const cand = p.candidates.find((c) => c.id === p.pickedCandidate);
  if (!cand || !p.concept) throw new Error("pick a candidate first");
  const source = await imageSize(await readAsset(id, cand.file));
  const svgs: Record<string, string> = {};
  for (const c of p.components) if (c.include && isVectorAsset(c.svg)) svgs[c.id] = (await readAsset(id, c.svg!)).toString("utf8");
  // An excluded plain background layer becomes the canvas colour.
  const bg = p.components.find((c) => c.role === "container" && c.source === "layers" && !c.include && c.crop);
  const background = bg ? await dominantHex(await readAsset(id, bg.crop!)) : undefined;
  const input = { graph: p.concept, components: p.components, source, svgs, texts: p.texts, background };
  const scene = mode === "auto" ? await layoutAuto(input) : layoutOriginal(input);
  return update(id, (proj) => {
    proj.scene = scene;
    proj.workspace = null;
    proj.stage = "workspace";
  });
}

async function dominantHex(png: Buffer) {
  // A plain fill: the mean is exact (sharp's `dominant` is binned).
  const { channels } = await sharp(png).removeAlpha().stats();
  return "#" + channels.slice(0, 3).map((c) => Math.round(c.mean).toString(16).padStart(2, "0")).join("");
}

export async function saveWorkspace(id: string, workspace: unknown) {
  return update(id, (p) => {
    p.workspace = workspace;
  });
}
