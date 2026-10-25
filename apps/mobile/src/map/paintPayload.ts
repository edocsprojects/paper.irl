import {
  buildTerritoryPaint,
  buildTrailPaint,
  type TerritoryFeatureCollection,
  type TrailFeatureCollection,
} from "@paper-irl/rules";
import type { LobbyPayload, SeatView } from "../lib/api";

export type PaperPaintMessage = {
  type: "state";
  state: {
    arena: LobbyPayload["arena"];
    mode: LobbyPayload["mode"];
    seats: Array<SeatView & { you?: boolean }>;
    top3: LobbyPayload["top3"];
    /** Exact FeatureCollection flushLayers passes to trails.setData. */
    trails: TrailFeatureCollection;
    /** Territory polygons (with holes) for the owned-fill / owned-border layers. */
    territory: TerritoryFeatureCollection;
    /** Recent deaths → expanding burst on the map where the player fell. */
    deaths: { atMs: number; lat: number; lon: number; color: string }[];
    /** Recent (re)spawns → the land "pops" in at the ring. */
    pops: { atMs: number; lat: number; lon: number; color: string }[];
    serverNowMs: number;
    /** 'arena' fits the whole circle; 'close' is street-level around you. */
    zoomMode: ZoomMode;
  };
};

export type ZoomMode = "arena" | "close";

/**
 * Exact object RN injects into window.__paperPaint on every map update.
 * `state.trails` is what getSource('trails').setData must receive.
 */
export function buildPaperPaintMessage(
  lobby: LobbyPayload,
  youId: number,
  zoomMode: ZoomMode = "arena",
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
      color: s.color,
    })),
  );
  const territory = buildTerritoryPaint(
    lobby.seats.map((s) => ({ id: s.id, color: s.color, owned: s.owned })),
  );
  return {
    type: "state",
    state: {
      arena: lobby.arena,
      mode: lobby.mode,
      seats,
      top3: lobby.top3,
      trails,
      territory,
      deaths: (lobby.feed ?? [])
        .filter((f) => f.at)
        .map((f) => ({
          atMs: f.atMs,
          lat: f.at!.lat,
          lon: f.at!.lon,
          color: lobby.seats.find((s) => s.id === f.victimId)?.color ?? "#111111",
        })),
      pops: (lobby.pops ?? []).map((p) => ({
        atMs: p.atMs,
        lat: p.at.lat,
        lon: p.at.lon,
        color: lobby.seats.find((s) => s.id === p.seatId)?.color ?? "#111111",
      })),
      serverNowMs: lobby.serverNowMs ?? Date.now(),
      zoomMode,
    },
  };
}
