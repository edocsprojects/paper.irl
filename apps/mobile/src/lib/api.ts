import { apiBase } from "./config";

export type LatLon = { lat: number; lon: number };

/** Matches server `seatPublicView` / freeplay lobby seats. */
export type SeatView = {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  /** Open freehand trail (lat/lon), not graph edge ids. */
  trail: LatLon[];
  /** Closed territory rings (lat/lon). */
  owned: LatLon[][];
  position: LatLon | null;
  respawnAt: LatLon | null;
};

/** Matches server `lobbyPayload` — freeplay GPS, no path graph. */
export type LobbyPayload = {
  code: string;
  phase: string;
  durationMs: number;
  startedAtMs: number | null;
  endsAtMs: number | null;
  maxSeats: number;
  mode: "freeplay";
  arena: {
    id: string;
    centerLat: number;
    centerLon: number;
    radiusM: number;
  };
  seats: SeatView[];
  top3: SeatView[];
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? res.statusText);
  return body as T;
}

export const api = {
  health: () =>
    req<{
      ok: boolean;
      mode: string;
      arena: string;
      radiusM: number;
      center: LatLon;
    }>("/health"),
  createLobby: (durationMs = 15 * 60 * 1000) =>
    req<{ code: string; phase: string; maxSeats: number; mode: string }>(
      "/lobbies",
      {
        method: "POST",
        body: JSON.stringify({ durationMs }),
      },
    ),
  join: (code: string, nickname: string) =>
    req<{ seat: SeatView; phase: string }>(`/lobbies/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ nickname }),
    }),
  fillBots: (code: string, leaveHumanSlots = 1) =>
    req<{ added: number }>(`/lobbies/${code}/bots/fill`, {
      method: "POST",
      body: JSON.stringify({ leaveHumanSlots }),
    }),
  start: (code: string) =>
    req<{ phase: string; endsAtMs: number }>(`/lobbies/${code}/start`, {
      method: "POST",
      body: "{}",
    }),
  get: (code: string) => req<LobbyPayload>(`/lobbies/${code}`),
  fix: (code: string, seatId: number, fix: Record<string, unknown>) =>
    req<LobbyPayload>(`/lobbies/${code}/fix`, {
      method: "POST",
      body: JSON.stringify({ seatId, fix }),
    }),
  autopilot: (code: string, seatId: number) =>
    req<LobbyPayload>(`/lobbies/${code}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ seatId }),
    }),
};
