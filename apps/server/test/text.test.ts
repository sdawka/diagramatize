import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { inkColor, matchTexts, ocrImage, similarity } from "../src/vector/ocr.js";
import { decodeRaw, inpaint, stripText } from "../src/vector/inpaint.js";

const W = 600, H = 300;
// A blue box with a white label, and a free black label below it.
const svg = (withText: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="60" y="40" width="300" height="120" fill="#3366cc"/>
  ${withText ? `<text x="210" y="115" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle">Compute</text>
  <text x="60" y="250" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#000000">Output queue</text>` : ""}
</svg>`;
const render = (withText: boolean) => sharp(Buffer.from(svg(withText))).png().toBuffer();

// Ground truth, from the geometry above (loose: glyph metrics vary by font).
const truth = [
  { text: "Compute", box: { x: 210 - 85, y: 80, w: 170, h: 45 } },
  { text: "Output queue", box: { x: 60, y: 215, w: 235, h: 45 } },
];

describe("text helpers", () => {
  it("compares strings leniently", () => {
    expect(similarity("Compute", "compute")).toBe(1);
    expect(similarity("Compute", "Cornpute")).toBeGreaterThan(0.7);
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("ocr boxes", () => {
  it("locate labels close to the drawn text, keeping the model's spelling", async (ctx) => {
    const img = await render(true);
    const ocr = await ocrImage(img);
    if (!ocr) return ctx.skip(); // no OCR language data and no network
    // Rough, shifted estimates as a vision model would give; the string is the model's.
    const texts = truth.map((t) => ({
      text: t.text,
      bbox: { x: (t.box.x - 12) / W, y: (t.box.y - 8) / H, w: (t.box.w + 20) / W, h: (t.box.h + 14) / H },
    }));
    const boxes = matchTexts(texts, ocr);
    for (const [i, t] of truth.entries()) {
      const b = boxes[i];
      expect(b, t.text).not.toBeNull();
      expect(Math.abs(b!.x * W - t.box.x)).toBeLessThan(18);
      expect(Math.abs(b!.y * H - t.box.y)).toBeLessThan(18);
      expect(Math.abs(b!.w * W - t.box.w)).toBeLessThan(30);
      expect(Math.abs(b!.h * H - t.box.h)).toBeLessThan(25);
    }
    // Colour comes from the pixels.
    expect(await inkColor(img, boxes[0]!)).toMatch(/^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/);
    const dark = (await inkColor(img, boxes[1]!))!;
    expect(parseInt(dark.slice(1, 3), 16)).toBeLessThan(40);
  }, 60_000);
});

describe("inpaint", () => {
  it("erases lettering from a layer and fills it with the surrounding colour", async () => {
    const img = await render(true);
    const frame = { width: W, height: H };
    const label = { bbox: { x: 85 / W, y: 75 / H, w: 250 / W, h: 60 / H }, color: "#ffffff" };
    // Layer = the box, cropped to its extent (the white page is not part of it).
    const layer = await sharp(img).extract({ left: 60, top: 40, width: 300, height: 120 }).png().toBuffer();
    const layerBox = { x: 60 / W, y: 40 / H, w: 300 / W, h: 120 / H };
    const before = await decodeRaw(layer);
    const r = await stripText(layer, layerBox, frame, [label]);
    expect(r.removed).toBeGreaterThan(200);
    const after = await decodeRaw(r.png);
    let white = 0, off = 0;
    for (let i = 0; i < after.width * after.height; i++) {
      const [R, G, B, A] = [after.data[i * 4], after.data[i * 4 + 1], after.data[i * 4 + 2], after.data[i * 4 + 3]];
      if (R > 200 && G > 200 && B > 200) white++;
      if (A !== 255 || Math.hypot(R - 0x33, G - 0x66, B - 0xcc) > 25) off++;
    }
    let whiteBefore = 0;
    for (let i = 0; i < before.width * before.height; i++) if (before.data[i * 4] > 200 && before.data[i * 4 + 1] > 200) whiteBefore++;
    expect(whiteBefore).toBeGreaterThan(300);
    expect(white).toBe(0);
    expect(off).toBeLessThan(40); // the hole is box-coloured again
  });

  it("makes a hole transparent where the layer has nothing around it", async () => {
    const w = 40, h = 20;
    const raw = Buffer.alloc(w * h * 4); // fully transparent...
    for (let y = 8; y < 12; y++) for (let x = 10; x < 30; x++) raw.set([0, 0, 0, 255], (y * w + x) * 4); // ...but a black bar
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const mask = new Uint8Array(w * h);
    for (let y = 7; y < 13; y++) for (let x = 9; x < 31; x++) mask[y * w + x] = 1;
    const out = await decodeRaw(await inpaint(png, mask));
    expect(out.data.filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
  });

  it("leaves a larger shape passing under the box alone", async () => {
    const w = 200, h = 60;
    const bar = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="25" width="200" height="8" fill="#ffffff"/></svg>`;
    const png = await sharp(Buffer.from(bar)).png().toBuffer();
    const box = { bbox: { x: 80 / w, y: 15 / h, w: 40 / w, h: 30 / h }, color: "#ffffff" };
    const r = await stripText(png, { x: 0, y: 0, w: 1, h: 1 }, { width: w, height: h }, [box]);
    expect(r.removed).toBe(0);
  });
});
