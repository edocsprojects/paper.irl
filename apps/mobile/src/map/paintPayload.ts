import { buildTrailPaint, type TrailFeatureCollection } from "@paper-irl/rules";
import type { LobbyPayload, SeatView } from "../lib/api";

/**
 * Trail line layer style the MapLibre HTML must paint.
 * Width 0 or road-grey colors = invisible trail (CI must fail).
 */
export const TRAIL_LAYER_STYLE = {
  sourceId: "trails",
  layerId: "trails",
  casingLayerId: "trails-casing",
  /** Trails must be added after this fill so the line is not buried. */
  aboveLayerId: "owned-fill",
  coreColor: "#111111",
  coreWidth: 5.5,
  caseColor: "#ffffff",
  caseWidth: 9,
} as const;

export type PaperPaintMessage = {
  type: "state";
  state: {
    arena: LobbyPayload["arena"];
    mode: LobbyPayload["mode"];
    seats: Array<SeatView & { you?: boolean }>;
    top3: LobbyPayload["top3"];
    /** Exact FeatureCollection flushLayers passes to trails.setData. */
    trails: TrailFeatureCollection;
  };
};

/**
 * Exact object RN injects into window.__paperPaint on every map update.
 * `state.trails` is what getSource('trails').setData must receive.
 */
export function buildPaperPaintMessage(
  lobby: LobbyPayload,
  youId: number,
): PaperPaintMessage {
  const seats = lobby.seats.map((s: SeatView) => ({
    ...s,
    you: s.id === youId,
  }));
  const trails = buildTrailPaint(
    lobby.seats.map((s) => ({
      id: s.id,
      mode: s.mode,
      trail: s.trail,
      position: s.position,
    })),
  );
  return {
    type: "state",
    state: {
      arena: lobby.arena,
      mode: lobby.mode,
      seats,
      top3: lobby.top3,
      trails,
    },
  };
}

/**
 * Resolve the GeoJSON the map applies via setData.
 * Null means paint was skipped on update — a bug when a seat is trailing.
 */
export function trailsSetDataFromPaintMessage(
  msg: PaperPaintMessage,
): TrailFeatureCollection | null {
  const trails = msg?.state?.trails;
  if (!trails || trails.type !== "FeatureCollection") return null;
  return trails;
}

/**
 * Assert a trailing seat's line is in the setData payload.
 * Fails if paint was skipped, feature missing, or LineString has &lt;2 points.
 */
export function assertTrailingTrailInPaintPayload(
  msg: PaperPaintMessage,
  seatId: number,
): {
  setData: TrailFeatureCollection;
  line: PaperPaintMessage["state"]["trails"]["features"][number];
} {
  const setData = trailsSetDataFromPaintMessage(msg);
  if (!setData) {
    throw new Error(
      "paint skipped on update — trails FeatureCollection missing from __paperPaint payload",
    );
  }
  const line = setData.features.find(
    (f) => f.properties.kind === "trail" && f.properties.seatId === seatId,
  );
  if (!line) {
    throw new Error(
      `trails.setData payload has no LineString for trailing seat ${seatId}`,
    );
  }
  if (line.geometry.type !== "LineString") {
    throw new Error(
      `trail feature for seat ${seatId} is ${line.geometry.type}, expected LineString`,
    );
  }
  if (line.geometry.coordinates.length < 2) {
    throw new Error(
      `trail LineString for seat ${seatId} has ${line.geometry.coordinates.length} coords; need ≥2 to paint a visible line`,
    );
  }
  return { setData, line };
}
