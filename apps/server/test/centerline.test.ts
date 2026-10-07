import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { traceCenterline } from "../src/vector/centerline.js";
import { polylineLength, simplify, snapAxes, straighten } from "../src/vector/snap.js";
import { svgFills, traceFidelity, traceImage } from "../src/vector/vtracer.js";

/** Axes, a decaying curve and an arrow, drawn thin on a transparent background. */
const PLOT = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <g fill="none" stroke="#1f2a44" stroke-width="2.5" stroke-linecap="round">
    <path d="M40 20 L40.6 260 L370 261"/>
    <path d="M40 140 L370 140.4" stroke="#999999" stroke-width="1.5"/>
  </g>
  <path d="M42 230 C100 40 160 40 210 150 S300 230 368 100" fill="none" stroke="#d1342c" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M120 250 L300 250" stroke="#2c6ed1" stroke-width="2" fill="none"/>
  <path d="M290 243 L302 250 L290 257 Z" fill="#2c6ed1"/>
</svg>`;

const png = () => sharp(Buffer.from(PLOT), { density: 144 }).resize(800, 600).png().toBuffer();

describe("centerline tracing", () => {
  it("beats the fill trace on thin-line art and emits stroked, axis-aligned paths", async () => {
    const src = await png();
    const fill = await traceImage(src, { centerline: false });
    const both = await traceImage(src);
    expect(both.method).toBe("centerline");
    expect(both.fidelity).toBeGreaterThan(fill.fidelity + 0.03);
    expect(both.svg).toMatch(/stroke-linecap="round"/);
    expect(both.svg).toMatch(/fill="none"/);
    expect(svgFills(both.svg)).toEqual(expect.arrayContaining(["#d1342c"]));
  }, 60_000);

  it("snaps the axes to exact horizontals and verticals", async () => {
    const cl = (await traceCenterline(await png()))!;
    const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const m of cl.body.matchAll(/ d="(M[^"]+)"/g)) {
      if (m[1].includes("C")) continue;
      const pts = [...m[1].matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((q) => ({ x: +q[1], y: +q[2] }));
      for (let i = 1; i < pts.length; i++) segs.push({ x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y });
    }
    const long = segs.filter((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 300);
    expect(long.some((s) => s.y1 === s.y2)).toBe(true);
    expect(long.some((s) => s.x1 === s.x2)).toBe(true);
  }, 60_000);
});

describe("snap helpers", () => {
  it("snaps near-axis segments and straightens near-straight runs", () => {
    const s = snapAxes([{ x: 0, y: 0 }, { x: 100, y: 2 }, { x: 101, y: 80 }]);
    expect(s[0].y).toBe(s[1].y);
    expect(s[1].x).toBe(s[2].x);
    const line = straighten(Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 5 + (i % 2 ? 0.4 : -0.4) })), 1);
    expect(line).toHaveLength(2);
    expect(polylineLength(simplify([{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }], 0.5))).toBeCloseTo(10, 0);
  });
});
