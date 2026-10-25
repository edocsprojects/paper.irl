import type { Arena, LatLon } from "./types.js";

const EARTH_M = 6371000;

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const r1 = (lat1 * Math.PI) / 180;
  const r2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r1) * Math.cos(r2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local meters east/north from an origin (equirectangular). */
export function toLocalM(
  originLat: number,
  originLon: number,
  lat: number,
  lon: number,
): { x: number; y: number } {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lon - originLon) * metersPerDegLon,
    y: (lat - originLat) * metersPerDegLat,
  };
}

export function fromLocalM(
  originLat: number,
  originLon: number,
  x: number,
  y: number,
): LatLon {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    lat: originLat + y / metersPerDegLat,
    lon: originLon + x / metersPerDegLon,
  };
}

export function distanceToArenaCenterM(arena: Arena, p: LatLon): number {
  return haversineM(arena.centerLat, arena.centerLon, p.lat, p.lon);
}

export function isInsideArena(arena: Arena, p: LatLon, slackM = 0): boolean {
  return distanceToArenaCenterM(arena, p) <= arena.radiusM + slackM;
}

/** Soft-push: project onto the circle if outside. */
export function clampToArena(arena: Arena, p: LatLon): LatLon {
  const d = distanceToArenaCenterM(arena, p);
  if (d <= arena.radiusM) return p;
  if (d < 1e-6) {
    return fromLocalM(arena.centerLat, arena.centerLon, arena.radiusM * 0.98, 0);
  }
  const local = toLocalM(arena.centerLat, arena.centerLon, p.lat, p.lon);
  const scale = (arena.radiusM * 0.995) / d;
  return fromLocalM(
    arena.centerLat,
    arena.centerLon,
    local.x * scale,
    local.y * scale,
  );
}

export function circleRing(
  center: LatLon,
  radiusM: number,
  sides = 16,
): LatLon[] {
  const ring: LatLon[] = [];
  for (let i = 0; i < sides; i++) {
    const ang = (i / sides) * Math.PI * 2;
    ring.push(
      fromLocalM(
        center.lat,
        center.lon,
        Math.cos(ang) * radiusM,
        Math.sin(ang) * radiusM,
      ),
    );
  }
  // Close ring for GeoJSON consumers
  ring.push({ ...ring[0]! });
  return ring;
}

function ringLocals(
  originLat: number,
  originLon: number,
  ring: LatLon[],
): { x: number; y: number }[] {
  const pts = ring.map((p) => toLocalM(originLat, originLon, p.lat, p.lon));
  // Drop duplicate close point for math
  if (
    pts.length >= 2 &&
    Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) <
      0.05
  ) {
    return pts.slice(0, -1);
  }
  return pts;
}

/** Absolute area of a closed lat/lon ring (m²). */
export function ringAreaM2(ring: LatLon[]): number {
  if (ring.length < 3) return 0;
  const origin = ring[0]!;
  const pts = ringLocals(origin.lat, origin.lon, ring);
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function ringCentroid(ring: LatLon[]): LatLon {
  const origin = ring[0]!;
  const pts = ringLocals(origin.lat, origin.lon, ring);
  if (!pts.length) return { ...origin };
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return fromLocalM(origin.lat, origin.lon, cx, cy);
}

/** Ray-cast point-in-polygon in local meters. */
export function pointInRing(point: LatLon, ring: LatLon[]): boolean {
  if (ring.length < 3) return false;
  const origin = ring[0]!;
  const pts = ringLocals(origin.lat, origin.lon, ring);
  const { x, y } = toLocalM(origin.lat, origin.lon, point.lat, point.lon);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i]!.x;
    const yi = pts[i]!.y;
    const xj = pts[j]!.x;
    const yj = pts[j]!.y;
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPointSegM(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from point to polyline (meters). */
export function distanceToPolylineM(point: LatLon, line: LatLon[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) {
    return haversineM(point.lat, point.lon, line[0]!.lat, line[0]!.lon);
  }
  const origin = line[0]!;
  const { x: px, y: py } = toLocalM(origin.lat, origin.lon, point.lat, point.lon);
  const pts = line.map((p) => toLocalM(origin.lat, origin.lon, p.lat, p.lon));
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    best = Math.min(best, distPointSegM(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

/** Distance to polygon boundary (meters). */
export function distanceToRingEdgeM(point: LatLon, ring: LatLon[]): number {
  return distanceToPolylineM(point, ring);
}

export function polylineLengthM(line: LatLon[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) {
    len += haversineM(
      line[i - 1]!.lat,
      line[i - 1]!.lon,
      line[i]!.lat,
      line[i]!.lon,
    );
  }
  return len;
}
