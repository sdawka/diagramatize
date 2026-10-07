/**
 * OpenRouter image model capabilities + pricing, fetched from the public listing and cached.
 * Requests are shaped from this so unsupported params (e.g. `background: transparent`
 * on gpt-image-2) are never sent.
 */

type Descriptor = { type: "enum"; values: string[] } | { type: "range"; min: number; max: number } | { type: "boolean" };

export interface ModelCaps {
  id: string;
  name: string;
  description: string;
  params: Record<string, Descriptor>;
  endpoints: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  role: "draft" | "final" | "vector" | "layers";
  note: string;
  refsMax: number;
  price: string;
}

/** Curated shortlist shown in the UI; any other OpenRouter model id can be typed in. */
export const CURATED: { id: string; role: CatalogEntry["role"]; note: string }[] = [
  { id: "recraft/recraft-v4.1-flash", role: "draft", note: "~1.5s, cheapest — great for exploring layouts" },
  { id: "openai/gpt-image-2", role: "final", note: "strongest text rendering + reference editing" },
  { id: "meta/muse-image", role: "final", note: "agentic: reasons about the layout before rendering (prompt only); needs 18+ confirmation in OpenRouter settings" },
  { id: "google/gemini-nano-banana-2.1", role: "final", note: "Nano Banana 2.1 — strong text and multi-reference consistency" },
  { id: "recraft/recraft-v4.1-pro", role: "final", note: "design/illustration focused" },
  { id: "black-forest-labs/flux.2-max", role: "final", note: "FLUX.2 — crisp illustration" },
  { id: "bytedance-seed/seedream-5-0-pro", role: "final", note: "Seedream 5 Pro" },
  { id: "qwen/qwen-image-3-pro", role: "final", note: "Qwen Image 3 Pro" },
  { id: "x-ai/grok-imagine-image-2.0", role: "final", note: "Grok Imagine 2" },
  { id: "microsoft/mai-image-2.6", role: "final", note: "MAI Image 2.6" },
  { id: "recraft/recraft-v4.1-vector", role: "vector", note: "native SVG output" },
  { id: "inclusionai/ming-image-0.1-design-layer", role: "layers", note: "splits a flat design into RGBA layers" },
];

const TTL = 60 * 60 * 1000;
let capsCache: { at: number; byId: Map<string, ModelCaps> } | null = null;
const priceCache = new Map<string, string>();

export async function modelCaps(id: string): Promise<ModelCaps | null> {
  if (!capsCache || Date.now() - capsCache.at > TTL) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/images/models");
      const json = (await res.json()) as { data: any[] };
      capsCache = {
        at: Date.now(),
        byId: new Map(
          json.data.map((m) => [
            m.id,
            { id: m.id, name: m.name, description: m.description ?? "", params: m.supported_parameters ?? {}, endpoints: m.endpoints },
          ]),
        ),
      };
    } catch {
      return null; // offline: fall back to sending params as-is
    }
  }
  return capsCache.byId.get(id) ?? null;
}

async function price(caps: ModelCaps): Promise<string> {
  if (priceCache.has(caps.id)) return priceCache.get(caps.id)!;
  let out = "see OpenRouter";
  try {
    const res = await fetch(`https://openrouter.ai${caps.endpoints}`);
    const json = (await res.json()) as any;
    const lines: any[] = json.endpoints?.[0]?.pricing ?? [];
    const perImage = lines.find((l) => l.billable === "output_image" && l.unit === "image");
    const perMp = lines.find((l) => l.billable === "output_image" && l.unit === "megapixel");
    if (perImage) out = `$${perImage.cost_usd}/image`;
    else if (perMp) out = `$${perMp.cost_usd}/MP`;
    else if (lines.length && lines.every((l) => Number(l.cost_usd) === 0)) out = "free";
    else if (lines.some((l) => l.unit === "token")) out = "token-billed";
  } catch {}
  priceCache.set(caps.id, out);
  return out;
}

export async function catalog(): Promise<CatalogEntry[]> {
  return Promise.all(
    CURATED.map(async (c) => {
      const caps = await modelCaps(c.id);
      const refs = caps?.params.input_references;
      return {
        ...c,
        name: caps?.name ?? c.id,
        refsMax: refs?.type === "range" ? refs.max : 0,
        price: caps ? await price(caps) : "?",
      };
    }),
  );
}

const ratio = (r: string) => {
  const [a, b] = r.split(":").map(Number);
  return a / b;
};

/** Shape request params to what the model accepts. */
export function fitParams(caps: ModelCaps | null, want: Record<string, unknown>, refs: number) {
  if (!caps) return { params: want, refs };
  const p = caps.params;
  const out: Record<string, unknown> = {};
  const enumHas = (k: string, v: unknown) => p[k]?.type === "enum" && (p[k] as any).values.includes(v);
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined) continue;
    if (k === "aspect_ratio" && p.aspect_ratio?.type === "enum") {
      const values = p.aspect_ratio.values.filter((x) => x !== "auto");
      out[k] = values.includes(v as string)
        ? v
        : values.sort((a, b) => Math.abs(ratio(a) - ratio(v as string)) - Math.abs(ratio(b) - ratio(v as string)))[0];
    } else if (enumHas(k, v)) {
      out[k] = v;
    }
  }
  const r = p.input_references;
  return { params: out, refs: r?.type === "range" ? Math.min(refs, r.max) : 0 };
}
