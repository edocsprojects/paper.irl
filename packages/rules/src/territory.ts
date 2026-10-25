import * as pcNs from "polygon-clipping";
import type { MultiPolygon, Pair, Polygon, Ring } from "polygon-clipping";
import { distanceToPolylineM, fromLocalM, pointInRing, toLocalM } from "./geo.js";
import type { LatLon, Territory } from "./types.js";

/**
 * Paper.io territory geometry: real (non-convex, holed) polygon boolean ops.
 * All math runs in local metres around a fixed origin (the arena center).
 *
 * polygon-clipping ships CJS with `module.exports = {...}`; under Node ESM it
 * only appears as `default`, under Metro/TS as named exports — accept both.
 */
const pc = ((pcNs as unknown as { default?: typeof pcNs }).default ?? pcNs) as typeof pcNs;

export type { MultiPolygon, Pair, Polygon, Ring };
export type Origin = { lat: number; lon: number };

/** Snap to centimetres — keeps the sweep-line clipper away from near-degenerate input. */
const SNAP = 100;
const snap = (v: number) => Math.round(v * SNAP) / SNAP;

export function toLocalPair(o: Origin, p: LatLon): Pair {
  const { x, y } = toLocalM(o.lat, o.lon, p.lat, p.lon);
  return [snap(x), snap(y)];
}

export function fromLocalPair(o: Origin, p: Pair): LatLon {
  return fromLocalM(o.lat, o.lon, p[0], p[1]);
}

export function territoryToLocal(o: Origin, t: Territory): MultiPolygon {
  return t.map((poly) => poly.map((ring) => ring.map((p) => toLocalPair(o, p))));
}

export function territoryFromLocal(o: Origin, mp: MultiPolygon): Territory {
  return mp.map((poly) =>
    poly.map((ring) => {
      const out = ring.map((p) => fromLocalPair(o, p));
      const f = out[0];
      const l = out[out.length - 1];
      if (f && l && (f.lat !== l.lat || f.lon !== l.lon)) out.push({ ...f });
      return out;
    }),
  );
}

function ringAreaLocal(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function polygonAreaLocal(poly: Polygon): number {
  if (!poly.length) return 0;
  let a = ringAreaLocal(poly[0]!);
  for (let i = 1; i < poly.length; i++) a -= ringAreaLocal(poly[i]!);
  return Math.max(0, a);
}

export function multiAreaLocal(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp) a += polygonAreaLocal(poly);
  return a;
}

export function territoryAreaM2(o: Origin, t: Territory): number {
  return multiAreaLocal(territoryToLocal(o, t));
}

/** Inside an outer ring and outside its holes, or within `slackM` of any edge. */
export function pointInTerritory(p: LatLon, t: Territory, slackM = 0): boolean {
  for (const poly of t) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    if (pointInRing(p, outer)) {
      let inHole = false;
      for (let i = 1; i < poly.length; i++) {
        if (pointInRing(p, poly[i]!)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    if (slackM > 0) {
      for (const ring of poly) {
        if (distanceToPolylineM(p, ring) <= slackM) return true;
      }
    }
  }
  return false;
}

function isEmpty(g: MultiPolygon | Polygon): boolean {
  return g.length === 0;
}

/** Union of any number of polygons / multipolygons. Never throws. */
export function unionAll(geoms: (MultiPolygon | Polygon)[]): MultiPolygon {
  const parts = geoms.filter((g) => !isEmpty(g));
  if (!parts.length) return [];
  try {
    return pc.union(parts[0]!, ...parts.slice(1));
  } catch {
    // Fold pairwise so one bad part does not lose the rest.
    let acc: MultiPolygon = [];
    for (const g of parts) {
      try {
        acc = acc.length ? pc.union(acc, g) : pc.union(g);
      } catch {
        /* skip degenerate part */
      }
    }
    return acc;
  }
}

export function differenceSafe(
  subject: MultiPolygon,
  clip: MultiPolygon,
): MultiPolygon {
  if (!subject.length) return [];
  if (!clip.length) return subject;
  try {
    return pc.difference(subject, clip);
  } catch {
    return subject;
  }
}

export function intersectionSafe(
  a: MultiPolygon | Polygon,
  b: MultiPolygon | Polygon,
): MultiPolygon {
  if (isEmpty(a) || isEmpty(b)) return [];
  try {
    return pc.intersection(a, b);
  } catch {
    return [];
  }
}

/** Drop interior rings — paper.io fills anything your land fully encloses. */
export function fillHoles(mp: MultiPolygon): MultiPolygon {
  return unionAll(mp.map((poly) => [poly[0]!] as Polygon));
}

export function dropSlivers(mp: MultiPolygon, minAreaM2: number): MultiPolygon {
  return mp.filter((poly) => polygonAreaLocal(poly) >= minAreaM2);
}

export function circleLocal(cx: number, cy: number, r: number, sides = 24): Polygon {
  const ring: Ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([snap(cx + Math.cos(a) * r), snap(cy + Math.sin(a) * r)]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return [ring];
}

/** Ramer–Douglas–Peucker on an open polyline. */
export function simplifyLine(pts: Pair[], tol: number): Pair[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s]!;
    const b = pts[e]!;
    let best = -1;
    let bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = distPointSeg(pts[i]!, a, b);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function distPointSeg(p: Pair, a: Pair, b: Pair): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Simplify every ring and re-normalise; falls back to the input if that fails. */
export function simplifyMulti(mp: MultiPolygon, tol: number): MultiPolygon {
  const out: Polygon[] = [];
  for (const poly of mp) {
    const rings: Ring[] = [];
    for (const ring of poly) {
      const open = ring.slice(0, -1);
      if (open.length < 3) continue;
      const s = simplifyLine([...open, open[0]!], tol);
      if (s.length < 4) {
        if (rings.length === 0) break; // outer collapsed → drop polygon
        continue;
      }
      rings.push(s);
    }
    if (rings.length) out.push(rings);
  }
  const clean = unionAll(out);
  const before = multiAreaLocal(mp);
  const after = multiAreaLocal(clean);
  // Guard against a simplification that self-intersected and lost area.
  if (before > 0 && Math.abs(after - before) > Math.max(2, before * 0.02)) return mp;
  return clean;
}

/**
 * Thick corridor around an open polyline (the trail's painted width).
 * Segment rectangles are extended by `halfW` at both ends so joints overlap.
 */
export function bufferPolyline(pts: Pair[], halfW: number): MultiPolygon {
  const line = simplifyLine(dedupe(pts), Math.min(0.5, halfW / 3));
  if (line.length === 0) return [];
  if (line.length === 1) return [circleLocal(line[0]![0], line[0]![1], halfW, 8)];
  const parts: Polygon[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy * halfW;
    const ny = ux * halfW;
    const ax = a[0] - ux * halfW;
    const ay = a[1] - uy * halfW;
    const bx = b[0] + ux * halfW;
    const by = b[1] + uy * halfW;
    const ring: Ring = [
      [snap(ax + nx), snap(ay + ny)],
      [snap(bx + nx), snap(by + ny)],
      [snap(bx - nx), snap(by - ny)],
      [snap(ax - nx), snap(ay - ny)],
    ];
    ring.push([ring[0]![0], ring[0]![1]]);
    parts.push([ring]);
  }
  return unionAll(parts);
}

function dedupe(pts: Pair[]): Pair[] {
  const out: Pair[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[0] - p[0]) < 0.01 && Math.abs(l[1] - p[1]) < 0.01) continue;
    out.push(p);
  }
  return out;
}

/** Closest point on any territory edge to `p` (lat/lon), or null if no land. */
export function nearestBoundaryPoint(o: Origin, t: Territory, p: LatLon): LatLon | null {
  const P = toLocalPair(o, p);
  let best: Pair | null = null;
  let bestD = Infinity;
  for (const poly of territoryToLocal(o, t)) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        let tt = l2 < 1e-12 ? 0 : ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / l2;
        tt = Math.max(0, Math.min(1, tt));
        const q: Pair = [a[0] + tt * dx, a[1] + tt * dy];
        const d = Math.hypot(P[0] - q[0], P[1] - q[1]);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
  }
  return best ? fromLocalPair(o, best) : null;
}

/** Proper 2D segment intersection (shared endpoints count). */
export function segmentsIntersect(a: Pair, b: Pair, c: Pair, d: Pair): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  const eps = 1e-9;
  if (Math.abs(o1) < eps && onSeg(a, b, c)) return true;
  if (Math.abs(o2) < eps && onSeg(a, b, d)) return true;
  if (Math.abs(o3) < eps && onSeg(c, d, a)) return true;
  if (Math.abs(o4) < eps && onSeg(c, d, b)) return true;
  return false;
}

function orient(a: Pair, b: Pair, c: Pair): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSeg(a: Pair, b: Pair, p: Pair): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-9 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}

/** Does segment a→b cross polyline `line` (local metres)? */
export function segmentHitsPolyline(a: Pair, b: Pair, line: Pair[]): boolean {
  for (let i = 0; i < line.length - 1; i++) {
    if (segmentsIntersect(a, b, line[i]!, line[i + 1]!)) return true;
  }
  return false;
}
