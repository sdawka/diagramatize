import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

// Must be set before modules read config.
process.env.LLM_PROVIDER = "mock";
process.env.IMAGE_PROVIDER = "mock";
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "diagram-test-"));

const store = await import("../src/lib/store.js");
const stages = await import("../src/pipeline/stages.js");
const { vectorize, svgFills } = await import("../src/vector/vtracer.js");
const { removeBackground } = await import("../src/vector/raster.js");

const noop = async () => {};

describe("vectorize", () => {
  it("traces a flat icon to a recolorable SVG without a background path", async () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#fff"/><circle cx="150" cy="150" r="110" fill="#3b82f6" stroke="#1f2937" stroke-width="8"/><circle cx="150" cy="150" r="40" fill="#f59e0b"/></svg>`;
    const png = await sharp(Buffer.from(icon)).png().toBuffer();
    const svg = await vectorize(png);
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 /);
    const fills = svgFills(svg);
    expect(fills.length).toBeGreaterThanOrEqual(3);
    // White background removed: no near-white fill should dominate.
    expect(fills[0]).not.toMatch(/^#f[ef]f[ef]f[ef]$/i);
  });

  it("removeBackground clears border-connected background only", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#ffffff"/><rect x="10" y="10" width="30" height="30" fill="#000"/><rect x="20" y="20" width="10" height="10" fill="#ffffff"/></svg>`;
    const out = await removeBackground(await sharp(Buffer.from(svg)).png().toBuffer());
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alpha(2, 2)).toBe(0); // outer background
    expect(alpha(15, 15)).toBe(255); // black square
    expect(alpha(25, 25)).toBe(255); // enclosed white stays
  });
});

describe("pipeline (mock providers)", () => {
  let id: string;

  beforeAll(async () => {
    id = (await store.createProject("How a CPU cache works")).id;
  });

  it("clarify → answers → concept", async () => {
    await stages.clarify(id);
    let p = await store.load(id);
    expect(p.clarify).toHaveLength(1);
    expect(p.clarify[0].questions.length).toBeGreaterThan(0);
    expect(p.clarify[0].analysis.waysOfSeeing).toContain("how");

    await stages.answer(id, { audience: "Beginners", style: "Literal" });
    p = await store.load(id);
    expect(p.stage).toBe("concept");
    expect(p.concept?.nodes.length).toBe(4);
  });

  it("approve → candidates → pick → decompose", async () => {
    await stages.approveConcept(id);
    expect((await store.load(id)).stage).toBe("composition");
    await stages.composeAndDraw(id, undefined, noop);
    const drawn = await store.load(id);
    // Each option is drawn as one whole figure; no per-element sketches up front.
    expect(drawn.compositions.every((c) => c.draft?.file)).toBe(true);
    expect(Object.keys(drawn.prototypes)).toHaveLength(0);
    await stages.drawComposition(id, drawn.compositions[0].id, "make the server bigger");
    const comps = (await store.load(id)).compositions;
    expect(comps[0].notes).toEqual(["make the server bigger"]);
    expect(comps[0].draft!.file).not.toBe(drawn.compositions[0].draft!.file);
    // Unchanged choice: the drawn draft guides the final images, with the user's notes.
    await stages.chooseComposition(id, comps[0]);
    await stages.candidates(id, { n: 1 }, noop);
    expect((await store.load(id)).candidates.at(-1)!.prompt).toMatch(/COMPOSITION DRAFT[\s\S]*make the server bigger/);
    await store.update(id, (proj) => void (proj.candidates = []));
    expect(comps.length).toBeGreaterThanOrEqual(2);
    const concept = (await store.load(id)).concept!;
    // Every node gets exactly one box, inside the frame.
    for (const c of comps) {
      expect(c.items.map((i) => i.nodeRef).sort()).toEqual(concept.nodes.map((n) => n.id).sort());
      for (const i of c.items) expect(i.x + i.w).toBeLessThanOrEqual(1.0001);
    }
    // Hand-adjusted boxes no longer match the draft: the box mock-up guides instead.
    await stages.chooseComposition(id, { ...comps[0], items: comps[0].items.slice(1) });
    const chosen = await store.load(id);
    expect(chosen.stage).toBe("candidates");
    expect(chosen.composition!.items).toHaveLength(concept.nodes.length);
    await stages.candidates(id, { n: 2 }, noop);
    expect((await store.load(id)).candidates[0].prompt).toMatch(/LAYOUT GUIDE[\s\S]*Composition: "Left-to-right flow"/);
    let p = await store.load(id);
    expect(p.stage).toBe("candidates");
    expect(p.candidates).toHaveLength(2);
    expect(p.candidates[0].ms).toBeTypeOf("number");

    await stages.pick(id, p.candidates[0].id, "boxes", noop);
    p = await store.load(id);
    expect(p.stage).toBe("decompose");
    expect(p.components.map((c) => c.nodeRef)).toEqual(p.concept!.nodes.map((n) => n.id));
    expect(p.components.every((c) => c.crop)).toBe(true);
  });

  it("build → workspace scene with SVG nodes, labels and edges", async () => {
    await stages.build(id, { regenerate: true }, noop);
    const p = await store.load(id);
    expect(p.stage).toBe("workspace");
    expect(p.components.every((c) => c.status === "done" && c.svg)).toBe(true);
    const scene = p.scene!;
    expect(scene.nodes).toHaveLength(4);
    expect(scene.edges).toHaveLength(3);
    expect(scene.nodes.every((n) => n.label?.text)).toBe(true);
    const svg = (await store.readAsset(id, scene.nodes[0].svg)).toString();
    expect(svg).toContain("<path");
  });

  it("auto layout places flow nodes left-to-right without overlaps", async () => {
    await stages.relayout(id, "auto");
    const nodes = (await store.load(id)).scene!.nodes;
    for (let i = 1; i < nodes.length; i++) expect(nodes[i].x).toBeGreaterThan(nodes[i - 1].x + nodes[i - 1].w);
  });

  it("multi-model candidates and draft → final re-render", async () => {
    const before = (await store.load(id)).candidates.length;
    await stages.candidates(id, { models: ["mock-a", "mock-b"], n: 1 }, noop);
    let p = await store.load(id);
    expect(p.candidates.slice(before).map((c) => c.model).sort()).toEqual(["mock-a", "mock-b"]);
    const draft = p.candidates.at(-1)!;
    await stages.candidates(id, { models: ["mock-final"], n: 1, referenceId: draft.id }, noop);
    p = await store.load(id);
    expect(p.candidates.at(-1)!.referenceId).toBe(draft.id);
  });

  it("layer split isolates each node icon on transparent pixels", async () => {
    let p = await store.load(id);
    await stages.pick(id, p.candidates[0].id, "layers", noop);
    p = await store.load(id);
    expect(p.components.every((c) => c.source === "layers")).toBe(true);
    const png = await store.readAsset(id, p.components[0].crop!);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // corner is transparent: no background, no neighbours
    await stages.build(id, { regenerate: false }, noop);
    expect((await store.load(id)).scene!.nodes).toHaveLength(4);
  });

  it("records cost and latency per stage", async () => {
    const { withStage } = await import("../src/lib/usage.js");
    await withStage(id, "candidates", () => stages.candidates(id, { n: 1 }, noop));
    const p = await store.load(id);
    const ev = p.usage.filter((u) => u.stage === "candidates");
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].kind).toBe("image");
    expect(ev[0].ref).toBe(p.candidates.at(-1)!.id);
    expect(ev[0].cost).toBe(0);
  });

  it("rebuilding one component swaps its asset in the scene", async () => {
    const before = (await store.load(id)).scene!.nodes[0].svg;
    await new Promise((r) => setTimeout(r, 5));
    const out = await stages.rebuildComponent(id, "input", { regenerate: false });
    const after = (await store.load(id)).scene!.nodes.find((n) => n.componentId === "input")!.svg;
    expect(after).toBe(out.svg);
    expect(after).not.toBe(before);
  });
  it("whole-layer split keeps layers as components and text as editable scene text", async () => {
    let p = await store.load(id);
    await stages.pick(id, p.candidates[0].id, "whole", noop);
    p = await store.load(id);
    expect(p.split).toBe("whole");
    // Mock layer model: one foreground layer (the drawn nodes) + an opaque background layer (excluded, becomes the canvas colour).
    // Bound first: the foreground's separate objects become separate components, each tightly boxed.
    const parts = p.components.filter((c) => c.include);
    expect(parts.length).toBeGreaterThanOrEqual(p.concept!.nodes.length);
    expect(p.components.find((c) => !c.include)?.role).toBe("container");
    // Node icons get their own tight boxes (a connector may still span the frame).
    expect(parts.filter((c) => c.bbox.w < 0.3).length).toBeGreaterThanOrEqual(p.concept!.nodes.length);
    for (const c of parts) {
      expect(c.nodeRef).toBeNull();
      expect(c.bbox.x + c.bbox.w).toBeLessThanOrEqual(1.0001);
    }
    expect(p.texts.map((t) => t.text)).toEqual(p.concept!.nodes.map((n) => n.label));

    // Default: no vectorizing — the original pixels are placed.
    await stages.build(id, { regenerate: false, keepOriginal: true }, noop);
    let scene = (await store.load(id)).scene!;
    expect(scene.nodes).toHaveLength(parts.length);
    expect(scene.nodes.every((n) => n.svg.endsWith(".png"))).toBe(true);
    expect(scene.edges).toHaveLength(0); // no invented connectors
    expect(scene.texts).toHaveLength(p.concept!.nodes.length);
    expect(scene.texts[0].fontSize).toBeGreaterThan(8);

    // Vectorize where faithful: flat mock shapes trace well, and every result records its fidelity.
    await stages.build(id, { regenerate: false, minFidelity: 0.95 }, noop);
    const built = (await store.load(id)).components.filter((c) => c.include);
    expect(built.every((c) => c.fidelity != null && (c.svg!.endsWith(".svg") === c.fidelity >= 0.95))).toBe(true);
    expect(built.some((c) => c.svg!.endsWith(".svg"))).toBe(true);
    scene = (await store.load(id)).scene!;
    expect(scene.background).toBe("#ffffff");
  });
});
