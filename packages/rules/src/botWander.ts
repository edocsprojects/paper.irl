import {
  clampToArena,
  fromLocalM,
  toLocalM,
} from "./geo.js";
import { applyFix } from "./lobby.js";
import type { Effect, LatLon, LobbyState, Seat, SeatId } from "./types.js";

const headings = new Map<SeatId, number>();

/**
 * Human walk/jog distance per tick (~200ms).
 * 0.35–0.85 m @ 5 Hz ≈ 1.8–4.3 m/s — readable, not teleport hops.
 */
const STEP_MIN_M = 0.35;
const STEP_SPAN_M = 0.5;

function wanderStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  autoPlant: boolean,
): LatLon {
  const arena = state.arena;
  const pos =
    seat.position ??
    seat.respawnAt ??
    ({ lat: arena.centerLat, lon: arena.centerLon } as LatLon);

  // Auto-plant seats (bots / Auto sim): walk onto marker so applyFix plants.
  if (
    autoPlant &&
    (seat.mode === "toPlant" || seat.mode === "joining" || seat.mode === "ghost") &&
    seat.respawnAt
  ) {
    const marker = seat.respawnAt;
    const local = toLocalM(pos.lat, pos.lon, marker.lat, marker.lon);
    const dist = Math.hypot(local.x, local.y);
    if (dist < 1.5) return { ...marker };
    const heading = Math.atan2(local.y, local.x);
    headings.set(seat.id, heading);
    const stepM = Math.min(STEP_MIN_M + rand() * STEP_SPAN_M, dist);
    return clampToArena(
      arena,
      fromLocalM(pos.lat, pos.lon, Math.cos(heading) * stepM, Math.sin(heading) * stepM),
    );
  }

  let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;

  // Manual / no-autoPlant while awaiting tap: drift near marker, never enter plant disk.
  if (
    !autoPlant &&
    (seat.mode === "toPlant" || seat.mode === "joining") &&
    seat.respawnAt
  ) {
    const marker = seat.respawnAt;
    const local = toLocalM(pos.lat, pos.lon, marker.lat, marker.lon);
    const dist = Math.hypot(local.x, local.y);
    const standoff = Math.max(state.plantRadiusM + 8, 28);
    if (dist > standoff) {
      heading = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.35;
    } else {
      heading = Math.atan2(local.y, local.x) + Math.PI + (rand() - 0.5) * 1.2;
    }
    headings.set(seat.id, heading);
    const stepM = STEP_MIN_M + rand() * STEP_SPAN_M;
    let next = fromLocalM(
      pos.lat,
      pos.lon,
      Math.cos(heading) * stepM,
      Math.sin(heading) * stepM,
    );
    next = clampToArena(arena, next);
    const after = toLocalM(next.lat, next.lon, marker.lat, marker.lon);
    if (Math.hypot(after.x, after.y) <= state.plantRadiusM + 2) {
      const ang = Math.atan2(after.y, after.x) || rand() * Math.PI * 2;
      next = fromLocalM(
        marker.lat,
        marker.lon,
        Math.cos(ang) * standoff,
        Math.sin(ang) * standoff,
      );
      next = clampToArena(arena, next);
    }
    return next;
  }

  if (seat.mode === "safe" && rand() < 0.4) {
    const prey = [...state.seats.values()].find(
      (s) => s.id !== seat.id && s.mode === "trailing" && s.trail.length >= 2,
    );
    if (prey) {
      const tip = prey.trail[prey.trail.length - 1]!;
      const local = toLocalM(pos.lat, pos.lon, tip.lat, tip.lon);
      heading = Math.atan2(local.y, local.x);
    } else {
      // Bias leaving starter so open trails show up quickly in demos.
      heading += (rand() - 0.5) * 1.6;
    }
  } else if (seat.mode === "trailing" && rand() < 0.5 && seat.owned[0]) {
    // Steer toward owned centroid so bots complete loops (not a ring vertex).
    const ring = seat.owned[0]!;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of ring) {
      const loc = toLocalM(pos.lat, pos.lon, p.lat, p.lon);
      sx += loc.x;
      sy += loc.y;
      n++;
    }
    const hx = n ? sx / n : 0;
    const hy = n ? sy / n : 0;
    heading = Math.atan2(hy, hx) + (rand() - 0.5) * 0.4;
  } else if (seat.mode === "safe" && rand() < 0.65) {
    heading += (rand() - 0.5) * 2.4;
  } else {
    heading += (rand() - 0.5) * 0.55;
  }

  const stepM = STEP_MIN_M + rand() * STEP_SPAN_M;
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

export type WanderOpts = {
  avoidSeatId?: SeatId;
  /**
   * When true (default), toPlant seats walk onto the marker and plant.
   * When false, motion continues but plant requires an explicit fix (Manual tap).
   */
  autoPlant?: boolean;
};

/**
 * One synthetic GPS step for a seat (plant / freeplay wander / light hunt).
 * Used by server bots and mobile Auto sim.
 */
export function wanderSeat(
  state: LobbyState,
  seatId: SeatId,
  rand: () => number,
  nowMs: number,
  opts?: WanderOpts,
): Effect[] {
  const seat = state.seats.get(seatId);
  if (!seat || seat.mode === "left") return [];

  const autoPlant = opts?.autoPlant !== false;
  const pos = wanderStep(state, seat, rand, autoPlant);
  // Tiny GPS jitter only — keep human-scale steps readable.
  return applyFix(
    state,
    seatId,
    {
      lat: pos.lat + (rand() - 0.5) * 0.000002,
      lon: pos.lon + (rand() - 0.5) * 0.000002,
      accuracyM: 4 + rand() * 2,
      speedMps: 1.4 + rand() * 2.2,
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
