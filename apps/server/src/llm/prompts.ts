import { stylePreset, type ClarifyRound, type Composition, type ConceptGraph, type DecomposedComponent } from "@diagram/core";

/** The project's chosen look: a preset plus optional free-text notes. */
export interface StyleChoice {
  stylePreset: string;
  styleNotes: string;
}

const notes = (s: StyleChoice) => (s.styleNotes.trim() ? ` Additional style direction: ${s.styleNotes.trim()}` : "");

const RUBRIC = `You are a visual explainer who designs diagrams from first principles.

Method:
1. Strip the concept to its essence: what is the one idea a viewer must walk away with?
2. Identify the irreducible parts: the actors/objects, the mechanism or relationships between them, and any quantities, places or sequence that matter. Leave out everything that is not load-bearing.
3. Classify which questions the concept answers, using Dan Roam's six ways of seeing:
   - who-what → portrait of the objects and their roles
   - how-much → quantitative comparison or chart
   - where → map / spatial arrangement
   - when → timeline / sequence
   - how → flowchart / process / mechanism
   - why → cause-and-effect or multi-variable plot
4. Choose the simplest diagram form that shows the real mechanism (flow, cycle, hierarchy/layers, side-by-side comparison, radial hub, spatial map). Prefer showing the mechanism over decorating it.
5. Every visual element should be a distinct, iconic object that can stand alone as a flat icon, so the diagram can later be decomposed into components.`;

export const CLARIFY_SYSTEM = `${RUBRIC}

Your task now: analyze the concept the user gives you and ask clarifying questions ONLY where the answer would materially change the diagram (audience and depth, which aspect to emphasize, metaphor vs literal depiction). The visual style has already been chosen by the user; do not ask about it. Ask 2-4 questions, each with 2-4 concrete suggested answers, and set "suggested" to the answer you would pick yourself so the user can simply confirm it. If prior answers are given and nothing important remains ambiguous, return an empty questions array.`;

export const CONCEPT_SYSTEM = `${RUBRIC}

Your task now: produce the diagram concept. Write the concept in words (prose) so a human can approve it, and a structured graph that later pipeline stages use:
- mainPoint: the ONE takeaway the figure exists to communicate, as a plain sentence (e.g. "Both sides must confirm before data flows"). Everything in the figure should serve it. If the user's answers or feedback state it, use their wording. If several takeaways are genuinely plausible, put the strongest in mainPoint and the others in mainPointAlternatives; otherwise leave alternatives empty.
- nodes: each is ONE standalone visual (an icon/illustration) plus a short text label. 3-8 nodes is ideal; never more than 12.
- visual: describe concretely what to draw for the node (e.g. "a laptop with a padlock on screen"), not the label.
- edges: the relationships/arrows between nodes, with short labels when the relationship is not obvious.
- palette and style: follow the user's chosen visual style brief (tone, audience, palette guidance). 3-5 colors (hex) plus a dark neutral for outlines/text.
- imagePrompt: a complete, self-contained prompt for an image model to draw the whole diagram in the chosen visual style on a plain white background. Lay the nodes out according to layoutIntent and direction, each as a separate, well-spaced visual with its short label underneath, connected by simple arrows. Specify the palette hex colors and the style's rendering details; flat solid fills, no gradients, no photorealism, no shadows, generous whitespace.`;

export const COMPOSITION_SYSTEM = `You are an information designer planning the composition of a single figure before it is illustrated.

Given an approved diagram concept (nodes, edges, main point, layout intent) and a visual style brief, propose 2-4 GENUINELY DIFFERENT compositions: different arrangements, not small variations. Draw on archetypes such as: linear flow (left-to-right or top-down), Z / zig-zag path, loop / cycle, hub and spokes, layered stack, central focal element with surrounding insets, side-by-side or before/after panels, anatomical/spatial map where position carries meaning. Only propose archetypes that honestly fit the concept; order options best first.

For each option:
- Make the MAIN POINT visually dominant: the element(s) carrying it are emphasis "focal" (one, at most two) and get the most size, a privileged position and isolation; key actors are "primary", supporting ones "secondary".
- Respect reading order (left-to-right, top-to-bottom), group related nodes by proximity, align elements on a clear grid, and keep arrows short and uncrossed where possible.
- items: exactly one per concept node, using its node id. Boxes are normalized (x, y = top-left as a fraction of width/height; w, h = size) and describe the node's VISUAL only. Keep >= 5% margins, no overlaps, and leave about 8% of the height free below each box for its text label. Visuals should be roughly square unless the object is naturally wide or tall.
- panels: only for genuinely multi-panel figures (comparisons, stages, insets); otherwise empty. Items belonging to a panel must lie inside it.
- aspectRatio: choose what suits the arrangement and the medium in the style brief (e.g. journal figures are usually 4:3 or 3:2, slides 16:9, posters and kids' pages may be portrait).`;

export function compositionUserMessage(g: ConceptGraph, style: StyleChoice, prev: Composition[], feedback?: string) {
  const preset = stylePreset(style.stylePreset);
  let msg = `Visual style: ${preset.label}. ${preset.concept}${notes(style)}\n\nApproved concept:\n${JSON.stringify(
    { title: g.title, mainPoint: g.mainPoint, layoutIntent: g.layoutIntent, direction: g.direction, nodes: g.nodes, edges: g.edges, prose: g.prose },
    null,
    2,
  )}`;
  if (prev.length && feedback) {
    msg += `\n\nPrevious options:\n${JSON.stringify(prev.map(({ name, aspectRatio, readingOrder, focal }) => ({ name, aspectRatio, readingOrder, focal })), null, 2)}\n\nThe user asked for: ${feedback}\nPropose new options accordingly.`;
  }
  return msg;
}

const where = (v: number) => (v < 0.34 ? 0 : v < 0.67 ? 1 : 2);
const ROWS = ["top", "middle", "bottom"];
const COLS = ["left", "centre", "right"];

/** The composition in words, for image models that cannot take a layout reference. */
export function describeComposition(c: Composition, g: ConceptGraph): string {
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  const items = [...c.items]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((i) => {
      const cx = i.x + i.w / 2, cy = i.y + i.h / 2;
      const area = i.w * i.h;
      const size = i.emphasis === "focal" || area > 0.08 ? "large" : area > 0.03 ? "medium" : "small";
      const pos = where(cx) === 1 && where(cy) === 1 ? "centre" : `${ROWS[where(cy)]} ${COLS[where(cx)]}`;
      return `"${label(i.nodeRef)}" at ${pos}, ${size}${i.emphasis === "focal" ? " (focal: most prominent)" : ""}`;
    });
  return [
    `Composition: "${c.name}", ${c.aspectRatio} frame. Reading order: ${c.readingOrder}. Focal emphasis: ${c.focal}.`,
    c.panels.length ? `Panels: ${c.panels.map((p) => `"${p.label}"`).join(", ")}.` : "",
    `Placement: ${items.join("; ")}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** One-shot draft of the WHOLE figure in a composition, so it can be judged as a diagram rather than parts. */
export function compositionDraftPrompt(c: Composition, g: ConceptGraph, style: StyleChoice, feedback?: string): string {
  return [
    `A complete, single diagram figure — one cohesive illustration, not a sheet of separate icons.`,
    `Arrangement: "${c.name}". ${c.rationale} Reading order: ${c.readingOrder}. Focal emphasis: ${c.focal}.`,
    describeComposition(c, g),
    candidatePrompt(g, style, undefined, null),
    c.notes.length ? `Changes the user asked for: ${c.notes.join("; ")}.` : "",
    feedback && !c.notes.includes(feedback) ? `Also: ${feedback}` : "",
    `These are layout instructions for you: do not write the reading order, arrangement name or any instructions as text in the image — only the diagram's own title and labels.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const DRAFT_GUIDE_NOTE =
  "COMPOSITION DRAFT: the attached reference image is an approved rough draft of this figure. Keep its overall composition — where each element sits, relative sizes, the flow and what is emphasised — but redraw everything as a polished, consistent final illustration in the style described. Fix any wrong, garbled or missing labels using the concept below.";

export const LAYOUT_GUIDE_NOTE =
  "LAYOUT GUIDE: the attached reference image is a rough mock-up of the required composition. Each element's position and size is shown either by a quick placeholder sketch or by a box (text under it is its label; an orange box marks the focal element; dashed regions are panels). Follow its arrangement and proportions closely. Treat the placeholder sketches as hints of WHAT to draw, not finished art: redraw every element polished and consistent in the style described, and do NOT draw boxes, dashed outlines or the wireframe's colors.";

/** A quick single-element icon draft (text-only prompt, e.g. Recraft flash) for composition mock-ups. */
export function prototypePrompt(visual: string, g: ConceptGraph, style: StyleChoice, feedback?: string): string {
  const palette = g.palette.map((p) => p.hex).join(", ");
  return [
    `A single standalone illustration of ${visual}.`,
    `Style: ${stylePreset(style.stylePreset).icon}${notes(style)} Colors: ${palette}.`,
    `Centered, filling most of the frame, on a pure white background. One object only: no text, no labels, no arrows, no scene, no shadow.`,
    feedback ? `Also: ${feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const DECOMPOSE_SYSTEM = `You decompose a diagram image into separately regenerable visual components.

Given the image and the concept graph it was made from, return one component per distinct visual element:
- For each concept node, find its icon/illustration and return a TIGHT bounding box around the visual ONLY: exclude its text label, exclude arrows and connectors. Set nodeRef to the node id.
- Also return the bounding box of the node's text label (labelBox) when one is visible, else null.
- If there are significant extra visuals (a background container/panel that groups nodes, or a decorative element that matters), add them with nodeRef null and role "container" or "decoration". Do not return arrows, connector lines, or standalone text.
- Boxes are normalized to the image: x,y = top-left corner as a fraction of width/height; w,h = size as a fraction. Be precise; slightly generous (a few pixels) is better than clipping the visual.
- ids: use the node id for node visuals, or a short kebab-case id otherwise.`;

export function clarifyUserMessage(topic: string, rounds: ClarifyRound[], style: StyleChoice): string {
  const preset = stylePreset(style.stylePreset);
  let msg = `Concept to diagram: ${topic}\n\nChosen visual style: ${preset.label}. ${preset.concept}${notes(style)}`;
  rounds.forEach((r, i) => {
    if (!r.answers) return;
    msg += `\n\nRound ${i + 1} answers:\n`;
    for (const q of r.questions) msg += `- ${q.question}\n  → ${r.answers[q.id] ?? "(no answer)"}\n`;
  });
  return msg;
}

export function conceptUserMessage(
  topic: string,
  rounds: ClarifyRound[],
  style: StyleChoice,
  prev: ConceptGraph | null,
  feedback?: string,
) {
  let msg = clarifyUserMessage(topic, rounds, style);
  const last = rounds.at(-1);
  if (last) msg += `\n\nYour first-principles analysis:\n${JSON.stringify(last.analysis, null, 2)}`;
  if (prev && feedback) {
    msg += `\n\nPrevious concept:\n${JSON.stringify(prev, null, 2)}\n\nThe user asked for these changes:\n${feedback}\nRevise the concept accordingly.`;
  }
  return msg;
}

export function candidatePrompt(g: ConceptGraph, style: StyleChoice, feedback?: string, composition?: Composition | null): string {
  const palette = g.palette.map((c) => `${c.name} ${c.hex}`).join(", ");
  return [
    g.imagePrompt,
    composition ? describeComposition(composition, g) : "",
    composition?.notes.length ? `Composition changes the user asked for: ${composition.notes.join("; ")}.` : "",
    g.mainPoint ? `The figure's main point, which the composition must make obvious through emphasis and visual hierarchy: ${g.mainPoint}` : "",
    `Visual style: ${stylePreset(style.stylePreset).image}${notes(style)}`,
    `Palette: ${palette}. ${g.style}. Plain white background.`,
    `Each element is a distinct, well-separated visual so it can be cut out individually. Labels are short and legible.`,
    feedback ? `Adjustments requested: ${feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function regenPrompt(c: DecomposedComponent, g: ConceptGraph, style: StyleChoice): string {
  const palette = g.palette.map((p) => p.hex).join(", ");
  return [
    `The first image is a crop from the second image (a full diagram). Redraw ONLY the main element in the crop — ${c.description} — as a single standalone illustration.`,
    `Style: ${stylePreset(style.stylePreset).icon}${notes(style)}`,
    `Match the second image's style exactly: same colors (${palette}), line weight and shapes.`,
    `Centered, filling about 85% of the frame, on a pure white background. No text, no letters, no labels, no arrows, no other elements, no shadow, no gradients.`,
  ].join("\n");
}

export const LAYERS_SYSTEM = `You prepare a diagram image for editing. A layer model has already split it into transparent layers; you get the full image and a sheet of the numbered layers (checkerboard = transparent).

1. For every layer on the sheet, give a short name for what it contains ("pipes", "compressor", "step numbers", "background") and its kind:
   - text: only lettering, words or numbers (a circled number badge counts as text only if it is just the digit)
   - connector: arrows, lines, pipes, flow paths
   - background: a plain or near-plain fill behind everything
   - art: anything else
2. Read EVERY piece of text in the full image: titles, labels, annotations, numbers inside badges. One item per separate text block (a two-line label is one item with "\\n" between lines). Copy the text exactly as drawn; fix only obvious rendering typos. Give a tight normalized box (0..1 of the full image), number of lines, the hex colour, whether it is bold, and its alignment.`;

export function layersUserMessage(g: ConceptGraph | null, layerIndexes: number[]): string {
  return [
    `Layers on the sheet: ${layerIndexes.join(", ")}. Name each of them.`,
    g ? `For reference, the diagram explains: ${g.title}. Expected labels include: ${g.nodes.map((n) => n.label).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
