import {
  clampToArena,
  fromLocalM,
  toLocalM,
} from "./geo.js";
import { applyFix } from "./lobby.js";
import type { Effect, LatLon, LobbyState, Seat, SeatId } from "./types.js";

const headings = new Map<SeatId, number>();

function wanderStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
): LatLon {
  const arena = state.arena;
  const pos =
    seat.position ??
    seat.respawnAt ??
    ({ lat: arena.centerLat, lon: arena.centerLon } as LatLon);

  if (
    (seat.mode === "toPlant" || seat.mode === "joining" || seat.mode === "ghost") &&
    seat.respawnAt
  ) {
    return { ...seat.respawnAt };
  }

  let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;

  if (seat.mode === "safe" && rand() < 0.35) {
    const prey = [...state.seats.values()].find(
      (s) => s.id !== seat.id && s.mode === "trailing" && s.trail.length >= 2,
    );
    if (prey) {
      const tip = prey.trail[prey.trail.length - 1]!;
      const local = toLocalM(pos.lat, pos.lon, tip.lat, tip.lon);
      heading = Math.atan2(local.y, local.x);
    } else {
      heading += (rand() - 0.5) * 1.0;
    }
  } else if (seat.mode === "trailing" && rand() < 0.35 && seat.owned[0]) {
    const home = seat.owned[0][0]!;
    const local = toLocalM(pos.lat, pos.lon, home.lat, home.lon);
    heading = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.7;
  } else {
    heading += (rand() - 0.5) * 1.15;
  }

  const stepM = 3.5 + rand() * 5.5;
  let next = fromLocalM(
    pos.lat,
    pos.lon,
    Math.cos(heading) * stepM,
    Math.sin(heading) * stepM,
  );
  next = clampToArena(arena, next);

  const after = toLocalM(arena.centerLat, arena.centerLon, next.lat, next.lon);
  if (Math.hypot(after.x, after.y) > arena.radiusM * 0.96) {
    heading += Math.PI * (0.55 + rand() * 0.5);
  }
  headings.set(seat.id, heading);
  return next;
}

/**
 * One synthetic GPS step for a seat (plant / freeplay wander / light hunt).
 * Used by server bots and mobile auto-pilot modes.
 */
export function wanderSeat(
  state: LobbyState,
  seatId: SeatId,
  rand: () => number,
  nowMs: number,
  _opts?: { avoidSeatId?: SeatId },
): Effect[] {
  const seat = state.seats.get(seatId);
  if (!seat || seat.mode === "left") return [];

  const pos = wanderStep(state, seat, rand);
  return applyFix(
    state,
    seatId,
    {
      lat: pos.lat + (rand() - 0.5) * 0.000012,
      lon: pos.lon + (rand() - 0.5) * 0.000012,
      accuracyM: 5 + rand() * 4,
      speedMps: 1 + rand() * 2.5,
      clientTsMs: nowMs,
      mock: true,
    },
    nowMs,
  );
}

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isBotNickname(nickname: string): boolean {
  return /^Bot\d+$/i.test(nickname);
}

export function seatIsBot(seat: Seat): boolean {
  return isBotNickname(seat.nickname);
}
