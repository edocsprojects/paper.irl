import {
  clampToArena,
  fromLocalM,
  haversineM,
  pointInRing,
  toLocalM,
} from "./geo.js";
import { applyFix } from "./lobby.js";
import type { Effect, LatLon, LobbyState, Seat, SeatId } from "./types.js";

const headings = new Map<SeatId, number>();

/**
 * Local-patch raid with crossing bias: leave starter, wander a nearby patch,
 * steer through other players' open trails / zone edges so cuts happen on
 * screen, then often bank home. Not a private orbit; not an arena sprint.
 */
type RaidPlan = {
  goal: LatLon;
  home: LatLon;
  minTrail: number;
  leashM: number;
};
const raids = new Map<SeatId, RaidPlan>();

/** Human walk/jog @ ~5 Hz: 0.4–0.85 m/tick ≈ 2–4.3 m/s. */
const STEP_MIN_M = 0.4;
const STEP_SPAN_M = 0.45;

function ringCentroid(ring: LatLon[]): LatLon {
  let lat = 0;
  let lon = 0;
  const n = Math.max(1, ring.length - (ring.length > 1 ? 1 : 0));
  for (let i = 0; i < n; i++) {
    lat += ring[i]!.lat;
    lon += ring[i]!.lon;
  }
  return { lat: lat / n, lon: lon / n };
}

/** Attractors that make open trails cross: prey tips, trail mids, neighbor homes. */
function crossingAttractors(
  state: LobbyState,
  self: Seat,
  home: LatLon,
  leashM: number,
): LatLon[] {
  const out: LatLon[] = [];
  for (const other of state.seats.values()) {
    if (other.id === self.id || other.mode === "left") continue;
    if (other.mode === "trailing" && other.trail.length >= 2) {
      const tip = other.trail[other.trail.length - 1]!;
      const mid = other.trail[Math.floor(other.trail.length / 2)]!;
      if (haversineM(home.lat, home.lon, tip.lat, tip.lon) < leashM) out.push(tip);
      if (haversineM(home.lat, home.lon, mid.lat, mid.lon) < leashM) out.push(mid);
    }
    if (other.position) {
      const d = haversineM(home.lat, home.lon, other.position.lat, other.position.lon);
      if (d < leashM && d > 8) out.push(other.position);
    }
    if (other.owned[0]) {
      const oh = ringCentroid(other.owned[0]);
      if (haversineM(home.lat, home.lon, oh.lat, oh.lon) < leashM) {
        // Aim just outside their border toward us — cross into contested space.
        const loc = toLocalM(oh.lat, oh.lon, home.lat, home.lon);
        const len = Math.hypot(loc.x, loc.y) || 1;
        out.push(
          fromLocalM(oh.lat, oh.lon, (loc.x / len) * 28, (loc.y / len) * 28),
        );
      }
    }
  }
  return out;
}

function leashClamp(
  arena: LobbyState["arena"],
  home: LatLon,
  goal: LatLon,
  maxM: number,
): LatLon {
  const d = haversineM(home.lat, home.lon, goal.lat, goal.lon);
  if (d <= maxM) return clampToArena(arena, goal);
  const loc = toLocalM(home.lat, home.lon, goal.lat, goal.lon);
  const scale = (maxM - 2) / d;
  return clampToArena(
    arena,
    fromLocalM(home.lat, home.lon, loc.x * scale, loc.y * scale),
  );
}

function pickLocalGoal(
  state: LobbyState,
  seat: Seat,
  home: LatLon,
  rand: () => number,
  leashM: number,
): LatLon {
  const arena = state.arena;
  const owned = seat.owned[0] ?? null;
  const attractors = crossingAttractors(state, seat, home, leashM);

  // Prefer aiming at another player's trail / zone so paths overlap.
  if (attractors.length && rand() < 0.72) {
    const target = attractors[Math.floor(rand() * attractors.length)]!;
    let goal = { ...target };
    // Nudge slightly so we actually cross the line rather than sit on a tip.
    goal = fromLocalM(
      goal.lat,
      goal.lon,
      (rand() - 0.5) * 10,
      (rand() - 0.5) * 10,
    );
    goal = leashClamp(arena, home, goal, leashM);
    if (!owned || !pointInRing(goal, owned)) return goal;
  }

  // Fallback: nearby random patch outside owned land.
  const dist = 22 + rand() * 28;
  const ang = rand() * Math.PI * 2;
  let goal = fromLocalM(home.lat, home.lon, Math.cos(ang) * dist, Math.sin(ang) * dist);
  goal = leashClamp(arena, home, goal, leashM);
  if (owned && pointInRing(goal, owned)) {
    goal = fromLocalM(home.lat, home.lon, Math.cos(ang) * (dist + 16), Math.sin(ang) * (dist + 16));
    goal = leashClamp(arena, home, goal, leashM);
  }
  return goal;
}

function stepToward(
  arena: LobbyState["arena"],
  pos: LatLon,
  goal: LatLon,
  rand: () => number,
  seatId: SeatId,
): LatLon {
  const local = toLocalM(pos.lat, pos.lon, goal.lat, goal.lon);
  const dist = Math.hypot(local.x, local.y);
  const heading = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.28;
  const stepM = Math.min(STEP_MIN_M + rand() * STEP_SPAN_M, Math.max(dist, STEP_MIN_M));
  headings.set(seatId, heading);
  return clampToArena(
    arena,
    fromLocalM(pos.lat, pos.lon, Math.cos(heading) * stepM, Math.sin(heading) * stepM),
  );
}

function ensureRaid(state: LobbyState, seat: Seat, pos: LatLon, rand: () => number): RaidPlan {
  const home = seat.owned[0] ? ringCentroid(seat.owned[0]) : pos;
  let plan = raids.get(seat.id);
  if (!plan || haversineM(plan.home.lat, plan.home.lon, home.lat, home.lon) > 35) {
    plan = {
      home,
      goal: pickLocalGoal(state, seat, home, rand, 85),
      minTrail: 12 + Math.floor(rand() * 14),
      leashM: 85,
    };
    raids.set(seat.id, plan);
  }
  return plan;
}

/** Live steer onto a nearby open trail for an on-screen cut attempt. */
function huntCrossing(
  state: LobbyState,
  seat: Seat,
  home: LatLon,
  leashM: number,
  rand: () => number,
): LatLon | null {
  const prey = [...state.seats.values()]
    .filter(
      (s) =>
        s.id !== seat.id &&
        s.mode === "trailing" &&
        s.trail.length >= 3,
    )
    .map((s) => {
      const tip = s.trail[s.trail.length - 1]!;
      const mid = s.trail[Math.floor(s.trail.length / 2)]!;
      return { tip, mid, d: haversineM(home.lat, home.lon, tip.lat, tip.lon) };
    })
    .filter((p) => p.d < leashM)
    .sort((a, b) => a.d - b.d);
  if (!prey.length) return null;
  const p = prey[0]!;
  // Aim at mid first (cross the body of the trail), else tip.
  return rand() < 0.55 ? p.mid : p.tip;
}

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

  if (
    autoPlant &&
    (seat.mode === "toPlant" || seat.mode === "joining" || seat.mode === "ghost") &&
    seat.respawnAt
  ) {
    raids.delete(seat.id);
    const marker = seat.respawnAt;
    const local = toLocalM(pos.lat, pos.lon, marker.lat, marker.lon);
    if (Math.hypot(local.x, local.y) < 1.5) return { ...marker };
    return stepToward(arena, pos, marker, rand, seat.id);
  }

  if (
    !autoPlant &&
    (seat.mode === "toPlant" || seat.mode === "joining") &&
    seat.respawnAt
  ) {
    raids.delete(seat.id);
    const marker = seat.respawnAt;
    const local = toLocalM(pos.lat, pos.lon, marker.lat, marker.lon);
    const dist = Math.hypot(local.x, local.y);
    const standoff = Math.max(state.plantRadiusM + 8, 28);
    let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;
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

  if (seat.mode === "safe" && seat.owned[0]) {
    const plan = ensureRaid(state, seat, pos, rand);
    // Often exit toward a crossing attractor (other trail / neighbor).
    if (rand() < 0.55) {
      const hunt = huntCrossing(state, seat, plan.home, plan.leashM, rand);
      if (hunt) return stepToward(arena, pos, hunt, rand, seat.id);
    }
    return stepToward(arena, pos, plan.goal, rand, seat.id);
  }

  if (seat.mode === "trailing" && seat.owned[0]) {
    const plan = ensureRaid(state, seat, pos, rand);
    const home = plan.home;
    const toGoal = toLocalM(pos.lat, pos.lon, plan.goal.lat, plan.goal.lon);
    const goalDist = Math.hypot(toGoal.x, toGoal.y);
    const readyToBank =
      seat.trail.length >= plan.minTrail ||
      (seat.trail.length >= 10 && goalDist < 5);

    // While out, keep crossing other open trails before heading home.
    if (!readyToBank && rand() < 0.5) {
      const hunt = huntCrossing(state, seat, home, plan.leashM, rand);
      if (hunt) return stepToward(arena, pos, hunt, rand, seat.id);
    }

    if (readyToBank) {
      return stepToward(arena, pos, home, rand, seat.id);
    }
    if (goalDist < 4) {
      plan.goal = pickLocalGoal(state, seat, home, rand, plan.leashM);
      raids.set(seat.id, plan);
    }
    const fromHome = haversineM(home.lat, home.lon, pos.lat, pos.lon);
    if (fromHome > plan.leashM) {
      return stepToward(arena, pos, home, rand, seat.id);
    }
    return stepToward(arena, pos, plan.goal, rand, seat.id);
  }

  let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;
  heading += (rand() - 0.5) * 0.7;
  const stepM = STEP_MIN_M + rand() * STEP_SPAN_M;
  let next = fromLocalM(
    pos.lat,
    pos.lon,
    Math.cos(heading) * stepM,
    Math.sin(heading) * stepM,
  );
  next = clampToArena(arena, next);
  headings.set(seat.id, heading);
  return next;
}

export type WanderOpts = {
  avoidSeatId?: SeatId;
  autoPlant?: boolean;
};

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

  if (seat.mode === "safe" && seat.trail.length === 0) {
    const plan = raids.get(seatId);
    if (plan && seat.owned[0] && pointInRing(pos, seat.owned[0])) {
      raids.delete(seatId);
    }
  }

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
