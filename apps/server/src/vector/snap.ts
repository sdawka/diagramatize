/** Polyline clean-up for centreline tracing: simplify, straighten, axis-snap, align and join. */

export interface Pt {
  x: number;
  y: number;
}

/** Segments within this many degrees of horizontal/vertical snap to exactly axis-aligned. */
export const AXIS_SNAP_DEG = 3;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function polylineLength(pts: Pt[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** Ramer–Douglas–Peucker. */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let worst = -1, wd = eps;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > wd) (wd = d), (worst = i);
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Light smoothing of pixel-grid staircases; endpoints stay put. */
export function smoothPath(pts: Pt[], passes = 2): Pt[] {
  let p = pts;
  for (let k = 0; k < passes && p.length > 2; k++) {
    p = p.map((q, i) => (i === 0 || i === p.length - 1 ? q : { x: (p[i - 1].x + 2 * q.x + p[i + 1].x) / 4, y: (p[i - 1].y + 2 * q.y + p[i + 1].y) / 4 }));
  }
  return p;
}

/**
 * If the whole polyline hugs one straight line (total-least-squares fit, max deviation ≤ tol),
 * collapse it to the two projected end points.
 */
export function straighten(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  // Out-and-back or looping runs are not straight, however thin.
  if (polylineLength(pts) > dist(pts[0], pts[pts.length - 1]) * 1.25 + 2) return pts;
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) (mx += p.x), (my += p.y);
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th), uy = Math.sin(th);
  let dev = 0;
  for (const p of pts) dev = Math.max(dev, Math.abs(-(p.x - mx) * uy + (p.y - my) * ux));
  if (dev > tol) return pts;
  const proj = (p: Pt): Pt => {
    const t = (p.x - mx) * ux + (p.y - my) * uy;
    return { x: mx + t * ux, y: my + t * uy };
  };
  return [proj(pts[0]), proj(pts[n - 1])];
}

/** Drop interior vertices that lie on (≈ within tol of) the line through their neighbours. */
export function mergeCollinear(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const ang1 = Math.atan2(b.y - a.y, b.x - a.x), ang2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(ang1 - ang2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (dist(a, b) < 0.05 || (segDist(b, a, c) <= tol && d < (20 * Math.PI) / 180)) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Snap each near-horizontal/vertical segment to an exact axis (shared vertices move together). */
export function snapAxes(pts: Pt[], deg = AXIS_SNAP_DEG): Pt[] {
  const p = pts.map((q) => ({ ...q }));
  const tan = Math.tan((deg * Math.PI) / 180);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    if (dx === 0 && dy === 0) continue;
    if (dy <= dx * tan) a.y = b.y = (a.y + b.y) / 2;
    else if (dx <= dy * tan) a.x = b.x = (a.x + b.x) / 2;
  }
  return p;
}

/** Cluster 1-D values within gap of each other; returns a map value→cluster mean. */
function cluster(values: number[], gap: number) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let group: number[] = [];
  const flush = () => {
    if (!group.length) return;
    const m = group.reduce((s, v) => s + v, 0) / group.length;
    for (const v of group) out.set(v, m);
    group = [];
  };
  for (const v of sorted) {
    if (group.length && v - group[group.length - 1] > gap) flush();
    group.push(v);
  }
  flush();
  return out;
}

/** Make parallel axis-aligned lines share exact coordinates (axes drawn twice, grid lines, frames). */
export function alignAxisLines(paths: Pt[][], gap: number) {
  const ys: number[] = [], xs: number[] = [];
  for (const p of paths)
    for (let i = 1; i < p.length; i++) {
      if (p[i].y === p[i - 1].y) ys.push(p[i].y);
      if (p[i].x === p[i - 1].x) xs.push(p[i].x);
    }
  const my = cluster(ys, gap), mx = cluster(xs, gap);
  for (const p of paths)
    for (let i = 1; i < p.length; i++) {
      if (p[i].y === p[i - 1].y && my.has(p[i].y)) {
        const y = my.get(p[i].y)!;
        p[i].y = p[i - 1].y = y;
      }
      if (p[i].x === p[i - 1].x && mx.has(p[i].x)) {
        const x = mx.get(p[i].x)!;
        p[i].x = p[i - 1].x = x;
      }
    }
}

/** Pull end points that sit within gap of each other onto their common centre (closes corners/junctions). */
export function joinEndpoints(paths: Pt[][], gap: number) {
  const ends: Pt[] = [];
  for (const p of paths) if (p.length) ends.push(p[0], p[p.length - 1]);
  const used = new Uint8Array(ends.length);
  for (let i = 0; i < ends.length; i++) {
    if (used[i]) continue;
    const grp = [i];
    for (let j = i + 1; j < ends.length; j++) if (!used[j] && dist(ends[i], ends[j]) <= gap) grp.push(j);
    if (grp.length < 2) continue;
    // Keep axis alignment: only move a point on the axis it is not pinned to.
    const cx = grp.reduce((s, k) => s + ends[k].x, 0) / grp.length;
    const cy = grp.reduce((s, k) => s + ends[k].y, 0) / grp.length;
    for (const k of grp) {
      used[k] = 1;
      ends[k].x = cx;
      ends[k].y = cy;
    }
  }
}

/** Concatenate paths that meet end-to-end at a point shared by exactly two paths and continue in the same direction. */
export function joinCollinearPaths(paths: Pt[][], gap: number, maxTurnDeg = 15): Pt[][] {
  const list = paths.filter((p) => p.length >= 2).map((p) => p.slice());
  const dir = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (const endI of [0, 1]) {
        const pi = list[i];
        const ei = endI ? pi[pi.length - 1] : pi[0];
        const cand: [number, number][] = [];
        for (let j = 0; j < list.length; j++) {
          if (j === i) continue;
          for (const endJ of [0, 1]) {
            const pj = list[j];
            if (dist(ei, endJ ? pj[pj.length - 1] : pj[0]) <= gap) cand.push([j, endJ]);
          }
        }
        // A true T/X junction has more than one partner (or other paths touching): leave it alone.
        let touching = 0;
        for (let j = 0; j < list.length; j++) {
          if (j === i) continue;
          const pj = list[j];
          if (dist(ei, pj[0]) <= gap || dist(ei, pj[pj.length - 1]) <= gap) touching++;
        }
        if (cand.length !== 1 || touching !== 1) continue;
        const [j, endJ] = cand[0];
        const a = endI ? pi : pi.slice().reverse(); // ends at the join
        const b = endJ ? list[j].slice().reverse() : list[j]; // starts at the join
        const d1 = dir(a[a.length - 2], a[a.length - 1]);
        const d2 = dir(b[0], b[1]);
        let turn = Math.abs(d1 - d2);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > (maxTurnDeg * Math.PI) / 180) continue;
        const joined = [...a.slice(0, -1), { x: (a[a.length - 1].x + b[0].x) / 2, y: (a[a.length - 1].y + b[0].y) / 2 }, ...b.slice(1)];
        list.splice(Math.max(i, j), 1);
        list.splice(Math.min(i, j), 1, joined);
        merged = true;
        break outer;
      }
    }
  }
  return list;
}

const turnAt = (a: Pt, b: Pt, c: Pt) => {
  let t = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(c.y - b.y, c.x - b.x));
  if (t > Math.PI) t = 2 * Math.PI - t;
  return t;
};

/** Intersection of the infinite lines a1-a2 and b1-b2, or null when (nearly) parallel. */
function intersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y, dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-6 * Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2)) return null;
  const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / den;
  return { x: a1.x + t * dx1, y: a1.y + t * dy1 };
}

function project(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1);
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * Full clean-up for one traced centreline. `tol` is the pixel tolerance (≈ 1px), `width` the stroke width.
 * The path is cut at corners, each straight run is collapsed to one segment, and the short diagonal
 * that thinning leaves across a sharp corner is replaced by the true intersection of its neighbours.
 */
export function cleanPath(pts: Pt[], tol: number, width = 2, smooth = true): Pt[] {
  const p = simplify(smooth ? smoothPath(pts, 2) : pts, tol);
  const turn = (18 * Math.PI) / 180;
  let pieces: Pt[][] = [[p[0]]];
  for (let i = 1; i < p.length; i++) {
    pieces[pieces.length - 1].push(p[i]);
    if (i < p.length - 1 && turnAt(p[i - 1], p[i], p[i + 1]) >= turn) pieces.push([p[i]]);
  }
  pieces = pieces.map((pc) => straighten(pc, Math.max(tol * 1.4, polylineLength(pc) * 0.005)));
  const cut = 1.5 * width + 2;
  const straight = (pc?: Pt[]) => !!pc && pc.length === 2 && polylineLength(pc) > cut;
  for (let i = 0; i < pieces.length && pieces.length > 1; i++) {
    if (polylineLength(pieces[i]) >= cut) continue;
    let j = i;
    while (j + 1 < pieces.length && polylineLength(pieces[j + 1]) < cut) j++;
    const prev = pieces[i - 1], next = pieces[j + 1];
    const run = pieces.slice(i, j + 1);
    const runLen = run.reduce((s, r) => s + polylineLength(r), 0);
    if (prev && next && straight(prev) && straight(next) && runLen < cut * 2) {
      // A short detour between two straight runs: a cut corner (intersect) or a thinning spur (drop).
      const x = intersect(prev[0], prev[1], next[0], next[1]);
      if (x && dist(x, prev[1]) <= cut * 1.5 && dist(x, next[0]) <= cut * 1.5) {
        prev[1] = x;
        next[0] = x;
      }
      pieces.splice(i, j - i + 1);
      i--;
    } else if (!prev && straight(next)) {
      next[0] = project(run[0][0], next[0], next[next.length - 1]);
      pieces.splice(i, j - i + 1);
      i--;
    } else if (!next && straight(prev)) {
      prev[prev.length - 1] = project(run[run.length - 1][run[run.length - 1].length - 1], prev[0], prev[prev.length - 1]);
      pieces.splice(i, j - i + 1);
      i--;
    }
  }
  const joined: Pt[] = [];
  for (const pc of pieces) for (const q of pc) if (!joined.length || joined[joined.length - 1] !== q) joined.push(q);
  return mergeCollinear(snapAxes(joined), tol * 0.5);
}

/**
 * Re-join a line that another colour crosses over: two path ends that face each other, are lined up
 * and have only foreign ink between them (`covered`) become one path. Dashed lines have empty gaps
 * and are left alone.
 */
export function bridgeGaps(paths: Pt[][], maxGap: number, covered: (x: number, y: number) => boolean, maxTurnDeg = 8): Pt[][] {
  const list = paths.filter((p) => p.length >= 2).map((p) => p.slice());
  const lim = (maxTurnDeg * Math.PI) / 180;
  const outward = (p: Pt[], end: number) => {
    const a = end ? p[p.length - 1] : p[0], b = end ? p[p.length - 2] : p[1];
    return Math.atan2(a.y - b.y, a.x - b.x);
  };
  const angDiff = (a: number, b: number) => {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  for (let again = true; again; ) {
    again = false;
    search: for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        for (const ei of [0, 1])
          for (const ej of [0, 1]) {
            const a = ei ? list[i][list[i].length - 1] : list[i][0];
            const b = ej ? list[j][list[j].length - 1] : list[j][0];
            const g = dist(a, b);
            if (g < 1.5 || g > maxGap) continue;
            const toB = Math.atan2(b.y - a.y, b.x - a.x);
            if (angDiff(outward(list[i], ei), toB) > lim || angDiff(outward(list[j], ej), toB + Math.PI) > lim) continue;
            let ok = true;
            for (let t = 1; t < g && ok; t++) ok = covered(a.x + ((b.x - a.x) * t) / g, a.y + ((b.y - a.y) * t) / g);
            if (!ok) continue;
            const first = ei ? list[i] : list[i].slice().reverse();
            const second = ej ? list[j].slice().reverse() : list[j];
            list[i] = [...first, ...second];
            list.splice(j, 1);
            again = true;
            break search;
          }
  }
  return list;
}
