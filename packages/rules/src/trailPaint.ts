import type { LatLon } from "./types.js";

export type TrailPaintSeat = {
  id: number;
  mode: string;
  trail: LatLon[];
  position?: LatLon | null;
};

export type TrailFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { kind: "trail"; seatId: number };
    geometry: {
      type: "LineString";
      coordinates: [number, number][];
    };
  }>;
};

/**
 * Build the MapLibre trails-layer FeatureCollection from seat state.
 * Open trails need ≥2 coordinates so the line is visible (not a degenerate tip).
 */
export function buildTrailPaint(seats: TrailPaintSeat[]): TrailFeatureCollection {
  const features: TrailFeatureCollection["features"] = [];
  for (const seat of seats) {
    const coords = trailLineCoords(seat);
    if (!coords || coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { kind: "trail", seatId: seat.id },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

function trailLineCoords(
  seat: TrailPaintSeat,
): [number, number][] | null {
  const base = seat.trail.map((p) => [p.lon, p.lat] as [number, number]);
  if (base.length >= 2) return base;
  if (base.length === 1 && seat.position) {
    const tip: [number, number] = [seat.position.lon, seat.position.lat];
    const a = base[0]!;
    if (Math.abs(a[0] - tip[0]) < 1e-9 && Math.abs(a[1] - tip[1]) < 1e-9) {
      return null;
    }
    return [a, tip];
  }
  return null;
}
