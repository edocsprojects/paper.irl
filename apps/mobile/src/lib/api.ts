import { apiBase } from "./config";

export type LatLon = { lat: number; lon: number };

/** Hardcoded testing location — shown as numbers, not a place name. */
export const TEST_LOCATION = {
  lat: 44.97452,
  lon: -93.23256,
} as const;

export type SeatView = {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  trail: LatLon[];
  owned: LatLon[][];
  position: LatLon | null;
  respawnAt: LatLon | null;
};

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
  rematchReady?: number[];
};

export type CreateLobbyOpts = {
  durationMs?: number;
  maxSeats?: number;
  radiusM?: number;
  centerLat?: number;
  centerLon?: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new Error(err);
  }
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
  createLobby: (opts: CreateLobbyOpts = {}) =>
    req<{
      code: string;
      phase: string;
      maxSeats: number;
      mode: string;
      arena: LobbyPayload["arena"];
    }>("/lobbies", {
      method: "POST",
      body: JSON.stringify({
        durationMs: opts.durationMs ?? 15 * 60 * 1000,
        maxSeats: opts.maxSeats ?? 8,
        radiusM: opts.radiusM ?? 500,
        centerLat: opts.centerLat ?? TEST_LOCATION.lat,
        centerLon: opts.centerLon ?? TEST_LOCATION.lon,
      }),
    }),
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
  rematchReady: (code: string, seatId: number) =>
    req<LobbyPayload>(`/lobbies/${code}/rematch/ready`, {
      method: "POST",
      body: JSON.stringify({ seatId }),
    }),
  rematchStart: (code: string, seatId: number) =>
    req<LobbyPayload>(`/lobbies/${code}/rematch/start`, {
      method: "POST",
      body: JSON.stringify({ seatId }),
    }),
};
