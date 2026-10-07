import type { ClarifyResult, Composition, ConceptGraph, DecomposedComponent } from "@diagram/core";
import { mockNodeBoxes } from "../images/mock.js";
import type { RawJsonCall } from "./types.js";

/**
 * Deterministic offline LLM so the full pipeline can be exercised without API keys.
 * Answers are shaped like real model output and validated against the same schemas.
 */
export const mockJson: RawJsonCall = async (req) => ({ value: mockValue(req), cost: 0 });

function mockValue(req: Parameters<RawJsonCall>[0]): unknown {
  if (req.name === "clarify") {
    const answered = req.messages.some((m) => typeof m.content === "string" && m.content.includes("answers:"));
    const out: ClarifyResult = {
      analysis: {
        coreIdea: "Something moves through a sequence of transformations.",
        firstPrinciples: ["an input", "a transformation step", "a result"],
        waysOfSeeing: ["how"],
        recommendedDiagram: "left-to-right flow",
        rationale: "The concept is a process, so a flow shows its mechanism most directly.",
      },
      questions: answered
        ? []
        : [
            {
              id: "audience",
              question: "Who is the diagram for?",
              why: "Sets the level of detail and vocabulary.",
              options: ["Beginners", "Practitioners", "Executives"],
            },
            {
              id: "style",
              question: "Literal objects or a metaphor?",
              why: "Changes what each icon depicts.",
              options: ["Literal", "Metaphor"],
            },
          ],
    };
    return out;
  }

  if (req.name === "concept") {
    const nodes = [
      { id: "input", label: "Input", visual: "a stack of paper documents" },
      { id: "process", label: "Process", visual: "a gear" },
      { id: "store", label: "Store", visual: "a database cylinder" },
      { id: "output", label: "Output", visual: "a bar chart on a screen" },
    ];
    const out: ConceptGraph = {
      title: "Mock concept",
      mainPoint: "Documents become insight through processing and storage.",
      mainPointAlternatives: [],
      prose: "A left-to-right flow: **input** documents are processed by a gear, stored, and turned into an output chart.",
      layoutIntent: "flow",
      direction: "RIGHT",
      style: "flat, rounded, friendly",
      palette: [
        { name: "blue", hex: "#3b82f6" },
        { name: "amber", hex: "#f59e0b" },
        { name: "green", hex: "#10b981" },
        { name: "ink", hex: "#1f2937" },
      ],
      nodes,
      edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, style: "arrow" as const })),
      imagePrompt: "Flat diagram of input → process → store → output.",
    };
    return out;
  }

  if (req.name === "composition") {
    const g = req.context as ConceptGraph;
    const n = g.nodes.length;
    const row: Omit<Composition, "notes"> = {
      id: "row",
      name: "Left-to-right flow",
      rationale: "Reads in order of the process.",
      aspectRatio: "3:2",
      readingOrder: "left to right",
      focal: "the last element is largest",
      panels: [],
      items: g.nodes.map((nd, i) => ({ nodeRef: nd.id, x: 0.05 + (i * 0.9) / n, y: 0.35, w: 0.9 / n - 0.05, h: 0.25, emphasis: i === n - 1 ? "focal" : "primary" })),
    };
    const col: Omit<Composition, "notes"> = {
      ...row,
      id: "column",
      name: "Top-down stack",
      aspectRatio: "3:4",
      readingOrder: "top to bottom",
      items: g.nodes.map((nd, i) => ({ nodeRef: nd.id, x: 0.35, y: 0.05 + (i * 0.9) / n, w: 0.3, h: 0.9 / n - 0.08, emphasis: i === 0 ? "focal" : "secondary" })),
    };
    return { options: [row, col] };
  }

  if (req.name === "layers") {
    // The mock layer model returns foreground + background; text sits in the foreground.
    const ctx = req.context as { layers: { index: number; coverage: number }[]; graph: ConceptGraph | null };
    const boxes = mockNodeBoxes(ctx.graph?.nodes.length ?? 0);
    return {
      layers: ctx.layers.map((l) => ({ index: l.index, name: l.coverage > 0.6 ? "background" : "artwork", kind: l.coverage > 0.6 ? "background" : "art" })),
      texts: (ctx.graph?.nodes ?? []).map((n, i) => ({ text: n.label, bbox: boxes[i].label, lines: 1, color: "#1f2937", bold: true, align: "center" })),
    };
  }

  // decompose: the mock image provider draws nodes at known positions.
  const graph = req.context as ConceptGraph;
  const boxes = mockNodeBoxes(graph.nodes.length);
  const components: DecomposedComponent[] = graph.nodes.map((n, i) => ({
    id: n.id,
    nodeRef: n.id,
    role: "icon",
    description: n.visual,
    bbox: boxes[i].icon,
    labelBox: boxes[i].label,
  }));
  return { components };
}
