// Probe: what does inclusionai/ming-image-0.1-design-layer return for a flat diagram?
// Usage: node --env-file=.env scripts/probe-layers.mjs <input.png> <outDir>
import fs from "node:fs/promises";
import path from "node:path";

const [input, outDir] = process.argv.slice(2);
const key = process.env.OPENROUTER_API_KEY;
const img = await fs.readFile(input);
const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/images", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "inclusionai/ming-image-0.1-design-layer",
    prompt: "Decompose this diagram into separate layers: background and each icon/element.",
    output_format: "png",
    input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${img.toString("base64")}` } }],
  }),
});
const json = await res.json();
console.log("status", res.status, "ms", Date.now() - t0);
if (!res.ok) {
  console.log(JSON.stringify(json).slice(0, 800));
  process.exit(1);
}
console.log("usage", JSON.stringify(json.usage));
console.log("keys", Object.keys(json), "data items", json.data?.length);
await fs.mkdir(outDir, { recursive: true });
for (const [i, d] of (json.data ?? []).entries()) {
  const { b64_json, ...meta } = d;
  const file = path.join(outDir, `layer-${i}.png`);
  await fs.writeFile(file, Buffer.from(b64_json, "base64"));
  console.log(i, JSON.stringify(meta), file);
}
