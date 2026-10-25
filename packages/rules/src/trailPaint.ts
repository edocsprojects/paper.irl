import type { LatLon, Territory } from "./types.js";

export type TrailPaintSeat = {
  id: number;
  mode: string;
  trail: LatLon[];
  position?: LatLon | null;
  color?: string;
};

export type TrailFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { kind: "trail"; seatId: number; color: string };
    geometry: {
      type: "LineString";
      coordinates: [number, number][];
    };
  }>;
};

export type TerritoryPaintSeat = {
  id: number;
  color: string;
  owned: Territory;
};

export type TerritoryFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { kind: "owned"; seatId: number; color: string };
    geometry: {
      type: "Polygon";
      coordinates: [number, number][][];
    };
  }>;
};

const DEFAULT_TRAIL_COLOR = "#111111";

/**
 * Build the MapLibre trails-layer FeatureCollection from seat state.
 * Only seats that are out of their land (trailing) draw a line, and the line
 * runs all the way to the player's head so it never lags behind the dot.
 */
export function buildTrailPaint(seats: TrailPaintSeat[]): TrailFeatureCollection {
  const features: TrailFeatureCollection["features"] = [];
  for (const seat of seats) {
    if (seat.mode !== "trailing") continue;
    const coords = trailLineCoords(seat);
    if (!coords || coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: {
        kind: "trail",
        seatId: seat.id,
        color: seat.color ?? DEFAULT_TRAIL_COLOR,
      },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

function same(a: [number, number], b: [number, number]) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function trailLineCoords(seat: TrailPaintSeat): [number, number][] | null {
  const base = seat.trail.map((p) => [p.lon, p.lat] as [number, number]);
  if (base.length === 0) return null;
  if (seat.position) {
    const tip: [number, number] = [seat.position.lon, seat.position.lat];
    if (!same(base[base.length - 1]!, tip)) base.push(tip);
  }
  return base.length >= 2 ? base : null;
}

/** Territory polygons (with holes) for the owned fill/border layers. */
export function buildTerritoryPaint(
  seats: TerritoryPaintSeat[],
): TerritoryFeatureCollection {
  const features: TerritoryFeatureCollection["features"] = [];
  for (const seat of seats) {
    for (const poly of seat.owned) {
      const rings = poly
        .filter((ring) => ring.length >= 4)
        .map((ring) => ring.map((p) => [p.lon, p.lat] as [number, number]));
      if (!rings.length) continue;
      features.push({
        type: "Feature",
        properties: { kind: "owned", seatId: seat.id, color: seat.color },
        geometry: { type: "Polygon", coordinates: rings },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
