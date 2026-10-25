import {
  clampToArena,
  fromLocalM,
  haversineM,
  toLocalM,
} from "./geo.js";
import { applyFix } from "./lobby.js";
import { nearestBoundaryPoint, pointInTerritory } from "./territory.js";
import type { Effect, LatLon, LobbyState, Seat, SeatId } from "./types.js";

/**
 * Local-patch raid with crossing bias: leave starter, wander a nearby patch,
 * steer through other players' open trails / zone edges so cuts happen on
 * screen, then bank home without crossing our own trail.
 */
type RaidPlan = {
  goal: LatLon;
  home: LatLon;
  leashM: number;
  /**
   * The loop this raid walks: waypoints on an arc around home. Most raids
   * are modest bites; some are bold sweeps that enclose a lot of land (and
   * leave a long trail to cut) — paper.io's risk/reward.
   */
  loop: LatLon[];
  loopIdx: number;
  /** Committed hunt (a coin flip per tick between two targets = jitter in place). */
  huntId: SeatId | null;
  huntUntilMs: number;
  /** Progress watchdog: re-plan if we have not really moved for a while. */
  checkAt: LatLon;
  checkMs: number;
};

const HUNT_COMMIT_MS = 5000;
/** Share of raids that are big, greedy loops. */
const BOLD_RAID_CHANCE = 0.35;
/** Spacing between loop waypoints (m). */
const LOOP_STEP_M = 14;

/**
 * Waypoints on an arc around home: radius + sweep pick how much land the
 * loop will enclose when the bot walks back in.
 */
function planLoop(state: LobbyState, home: LatLon, leashM: number, rand: () => number): LatLon[] {
  const bold = rand() < BOLD_RAID_CHANCE;
  const maxR = Math.max(24, Math.min(leashM * 0.8, state.arena.radiusM * 0.45));
  const r = bold
    ? Math.min(maxR, 45 + rand() * 50) // big sweep: 45–95 m out
    : Math.min(maxR, 24 + rand() * 18); // modest bite: 24–42 m out
  const sweep = bold
    ? ((200 + rand() * 120) * Math.PI) / 180 // 200–320°
    : ((90 + rand() * 90) * Math.PI) / 180; // 90–180°
  const dir = rand() < 0.5 ? 1 : -1;
  const a0 = rand() * Math.PI * 2;
  const n = Math.max(3, Math.ceil((r * sweep) / LOOP_STEP_M));
  const inner = { ...state.arena, radiusM: state.arena.radiusM - 6 };
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + dir * (sweep * i) / n;
    pts.push(clampToArena(inner, fromLocalM(home.lat, home.lon, Math.cos(a) * r, Math.sin(a) * r)));
  }
  return pts;
}
const STUCK_WINDOW_MS = 6000;
const STUCK_MIN_M = 4;

/** Bot memory is per lobby — seat ids restart at 1 in every lobby. */
const headings = new Map<string, number>();
const raids = new Map<string, RaidPlan>();
const keyOf = (state: LobbyState, id: SeatId) => `${state.code}#${id}`;

/** Real jog pace; lobby.speedScale multiplies it for demos. */
const BASE_SPEED_MPS = 3;
/** Max turn rate — bots curve like a person instead of zig-zagging. */
const MAX_TURN_RAD_PER_S = 2.4;
const lastStepMs = new Map<string, number>();

function stepSeconds(state: LobbyState, seat: Seat, nowMs: number): number {
  const key = keyOf(state, seat.id);
  const last = lastStepMs.get(key);
  lastStepMs.set(key, nowMs);
  if (last === undefined) return 0.2;
  return Math.max(0.05, Math.min(0.5, (nowMs - last) / 1000));
}

/** Each bot keeps its own steady pace (±15%) so they don't move in lockstep. */
function paceMps(state: LobbyState, seat: Seat): number {
  const personal = 0.85 + ((seat.id * 7919) % 31) / 100;
  return BASE_SPEED_MPS * personal * state.speedScale;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Vertex-average of a polygon's outer ring (good enough for a "home" aim). */
export function territoryCenter(seat: Seat): LatLon | null {
  let best: LatLon[] | null = null;
  for (const poly of seat.owned) {
    const outer = poly[0];
    if (outer && (!best || outer.length > best.length)) best = outer;
  }
  if (!best || best.length < 2) return null;
  let lat = 0;
  let lon = 0;
  const n = best.length - 1;
  for (let i = 0; i < n; i++) {
    lat += best[i]!.lat;
    lon += best[i]!.lon;
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
    const oh = territoryCenter(other);
    if (oh && haversineM(home.lat, home.lon, oh.lat, oh.lon) < leashM) {
      // Aim just outside their border toward us — cross into contested space.
      const loc = toLocalM(oh.lat, oh.lon, home.lat, home.lon);
      const len = Math.hypot(loc.x, loc.y) || 1;
      out.push(fromLocalM(oh.lat, oh.lon, (loc.x / len) * 28, (loc.y / len) * 28));
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
  const attractors = crossingAttractors(state, seat, home, leashM);

  // Prefer aiming at another player's trail / zone so paths overlap.
  if (attractors.length && rand() < 0.72) {
    const target = attractors[Math.floor(rand() * attractors.length)]!;
    let goal = fromLocalM(
      target.lat,
      target.lon,
      (rand() - 0.5) * 10,
      (rand() - 0.5) * 10,
    );
    goal = leashClamp(arena, home, goal, leashM);
    if (!pointInTerritory(goal, seat.owned)) return goal;
  }

  // Fallback: nearby random patch outside owned land.
  const dist = 22 + rand() * 28;
  const ang = rand() * Math.PI * 2;
  let goal = fromLocalM(home.lat, home.lon, Math.cos(ang) * dist, Math.sin(ang) * dist);
  goal = leashClamp(arena, home, goal, leashM);
  if (pointInTerritory(goal, seat.owned)) {
    goal = fromLocalM(home.lat, home.lon, Math.cos(ang) * (dist + 16), Math.sin(ang) * (dist + 16));
    goal = leashClamp(arena, home, goal, leashM);
  }
  return goal;
}

function stepToward(
  state: LobbyState,
  seat: Seat,
  pos: LatLon,
  goal: LatLon,
  rand: () => number,
  nowMs: number,
): LatLon {
  const arena = state.arena;
  const key = keyOf(state, seat.id);
  const dt = stepSeconds(state, seat, nowMs);
  const local = toLocalM(pos.lat, pos.lon, goal.lat, goal.lon);
  const dist = Math.hypot(local.x, local.y);
  const desired = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.06;
  const current = headings.get(key) ?? desired;
  const maxTurn = MAX_TURN_RAD_PER_S * dt;
  const base = current + Math.max(-maxTurn, Math.min(maxTurn, angleDiff(desired, current)));
  const stepM = Math.min(paceMps(state, seat) * dt, Math.max(dist, 0.05));
  const heading = base;
  const next = clampToArena(
    arena,
    fromLocalM(pos.lat, pos.lon, Math.cos(heading) * stepM, Math.sin(heading) * stepM),
  );
  headings.set(key, heading);
  return next;
}

/** A point a few metres inside our land on the side nearest `pos`. */
function homeEntry(state: LobbyState, seat: Seat, pos: LatLon): LatLon | null {
  const o = { lat: state.arena.centerLat, lon: state.arena.centerLon };
  const edge = nearestBoundaryPoint(o, seat.owned, pos);
  const c = territoryCenter(seat);
  if (!edge) return c;
  if (!c) return edge;
  const v = toLocalM(edge.lat, edge.lon, c.lat, c.lon);
  const len = Math.hypot(v.x, v.y) || 1;
  const inset = Math.min(6, len);
  return fromLocalM(edge.lat, edge.lon, (v.x / len) * inset, (v.y / len) * inset);
}

function ensureRaid(
  state: LobbyState,
  seat: Seat,
  pos: LatLon,
  rand: () => number,
  nowMs: number,
): RaidPlan {
  const home = territoryCenter(seat) ?? pos;
  const key = keyOf(state, seat.id);
  let plan = raids.get(key);
  if (!plan || haversineM(plan.home.lat, plan.home.lon, home.lat, home.lon) > 35) {
    // Roam far enough to reach the nearest neighbour — evenly spread players
    // must still meet, or the match is all banking and no cutting.
    let nearest = Infinity;
    for (const o of state.seats.values()) {
      if (o.id === seat.id) continue;
      const p = territoryCenter(o) ?? o.position;
      if (p) nearest = Math.min(nearest, haversineM(home.lat, home.lon, p.lat, p.lon));
    }
    const leashM = Math.min(
      state.arena.radiusM,
      Math.max(110, Number.isFinite(nearest) ? nearest * 0.85 : 110),
    );
    const loop = planLoop(state, home, leashM, rand);
    plan = {
      home,
      goal: loop[0]!,
      leashM,
      loop,
      loopIdx: 0,
      huntId: null,
      huntUntilMs: 0,
      checkAt: { ...pos },
      checkMs: nowMs,
    };
    raids.set(key, plan);
  }
  if (nowMs - plan.checkMs >= STUCK_WINDOW_MS) {
    if (haversineM(plan.checkAt.lat, plan.checkAt.lon, pos.lat, pos.lon) < STUCK_MIN_M) {
      // Stuck: skip ahead on the loop (or go home if it's done).
      plan.loopIdx = Math.min(plan.loop.length, plan.loopIdx + 1);
      plan.goal = plan.loop[plan.loopIdx] ?? pickLocalGoal(state, seat, home, rand, plan.leashM);
      plan.huntId = null;
    }
    plan.checkAt = { ...pos };
    plan.checkMs = nowMs;
  }
  return plan;
}

/**
 * Steer onto a nearby open trail for an on-screen cut attempt. Once a prey
 * is picked the bot commits to it for HUNT_COMMIT_MS instead of re-rolling
 * every tick.
 */
function huntCrossing(
  state: LobbyState,
  seat: Seat,
  plan: RaidPlan,
  rand: () => number,
  nowMs: number,
  startChance: number,
): LatLon | null {
  if (plan.huntId !== null && nowMs < plan.huntUntilMs) {
    const prey = state.seats.get(plan.huntId);
    if (prey && prey.mode === "trailing" && prey.trail.length >= 2) {
      return prey.trail[Math.floor(prey.trail.length / 2)]!;
    }
  }
  plan.huntId = null;
  if (rand() >= startChance) return null;
  const prey = [...state.seats.values()]
    .filter((s) => s.id !== seat.id && s.mode === "trailing" && s.trail.length >= 3)
    .map((s) => {
      const tip = s.trail[s.trail.length - 1]!;
      return { s, d: haversineM(plan.home.lat, plan.home.lon, tip.lat, tip.lon) };
    })
    .filter((p) => p.d < plan.leashM)
    .sort((a, b) => a.d - b.d)[0];
  if (!prey) return null;
  plan.huntId = prey.s.id;
  plan.huntUntilMs = nowMs + HUNT_COMMIT_MS;
  return prey.s.trail[Math.floor(prey.s.trail.length / 2)]!;
}

function randomStep(
  state: LobbyState,
  seat: Seat,
  pos: LatLon,
  rand: () => number,
  nowMs: number,
): LatLon {
  const key = keyOf(state, seat.id);
  const dt = stepSeconds(state, seat, nowMs);
  let heading = headings.get(key) ?? rand() * Math.PI * 2;
  heading += (rand() - 0.5) * 1.2 * dt;
  const d = haversineM(pos.lat, pos.lon, state.arena.centerLat, state.arena.centerLon);
  if (d > state.arena.radiusM * 0.85) {
    // Curve back toward the middle near the boundary.
    const toC = toLocalM(pos.lat, pos.lon, state.arena.centerLat, state.arena.centerLon);
    const want = Math.atan2(toC.y, toC.x);
    heading += Math.max(-MAX_TURN_RAD_PER_S * dt, Math.min(MAX_TURN_RAD_PER_S * dt, angleDiff(want, heading)));
  }
  const stepM = paceMps(state, seat) * dt * 0.6;
  const next = clampToArena(
    state.arena,
    fromLocalM(pos.lat, pos.lon, Math.cos(heading) * stepM, Math.sin(heading) * stepM),
  );
  headings.set(key, heading);
  return next;
}

function wanderStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  autoPlant: boolean,
  nowMs: number,
): LatLon {
  const arena = state.arena;
  const pos =
    seat.position ??
    seat.respawnAt ??
    ({ lat: arena.centerLat, lon: arena.centerLon } as LatLon);

  if (seat.mode === "toPlant" || seat.mode === "joining" || seat.mode === "ghost") {
    raids.delete(keyOf(state, seat.id));
    const marker = seat.respawnAt;
    // Head for the respawn ring (even while still a ghost); plant on entry.
    if (autoPlant && marker) {
      const local = toLocalM(pos.lat, pos.lon, marker.lat, marker.lon);
      if (Math.hypot(local.x, local.y) < 1.5) return { ...marker };
      return stepToward(state, seat, pos, marker, rand, nowMs);
    }
    // Not armed (or still a ghost): mill about — the marker follows us.
    return randomStep(state, seat, pos, rand, nowMs);
  }

  if (seat.mode === "safe" && seat.owned.length) {
    const plan = ensureRaid(state, seat, pos, rand, nowMs);
    // Sometimes exit toward someone's open trail (committed for a few s).
    const hunt = huntCrossing(state, seat, plan, rand, nowMs, 0.07);
    if (hunt) return stepToward(state, seat, pos, hunt, rand, nowMs);
    return stepToward(state, seat, pos, plan.goal, rand, nowMs);
  }

  if (seat.mode === "trailing" && seat.owned.length) {
    const plan = ensureRaid(state, seat, pos, rand, nowMs);
    const home = plan.home;
    // Walk the loop's waypoints; once it's done, head home to bank it.
    let toGoal = toLocalM(pos.lat, pos.lon, plan.goal.lat, plan.goal.lon);
    while (Math.hypot(toGoal.x, toGoal.y) < 5 && plan.loopIdx < plan.loop.length) {
      plan.loopIdx++;
      const next = plan.loop[plan.loopIdx];
      if (!next) break;
      plan.goal = next;
      toGoal = toLocalM(pos.lat, pos.lon, next.lat, next.lon);
    }
    const goalDist = Math.hypot(toGoal.x, toGoal.y);
    const readyToBank = plan.loopIdx >= plan.loop.length;

    // While out, sometimes go after another open trail before heading home.
    if (!readyToBank) {
      const hunt = huntCrossing(state, seat, plan, rand, nowMs, 0.05);
      if (hunt) return stepToward(state, seat, pos, hunt, rand, nowMs);
    }

    if (readyToBank) {
      return stepToward(state, seat, pos, homeEntry(state, seat, pos) ?? home, rand, nowMs);
    }
    void goalDist;
    const fromHome = haversineM(home.lat, home.lon, pos.lat, pos.lon);
    if (fromHome > plan.leashM) {
      return stepToward(state, seat, pos, homeEntry(state, seat, pos) ?? home, rand, nowMs);
    }
    return stepToward(state, seat, pos, plan.goal, rand, nowMs);
  }

  return randomStep(state, seat, pos, rand, nowMs);
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
  const pos = wanderStep(state, seat, rand, autoPlant, nowMs);
  // Remember open trail so we only reset the raid after a bank — never while
  // still walking out of the starter (that trapped bots inside the blob).
  const hadOpenTrail = seat.trail.length > 0 || seat.mode === "trailing";

  const effects = applyFix(
    state,
    seatId,
    {
      lat: pos.lat + (rand() - 0.5) * 0.000002,
      lon: pos.lon + (rand() - 0.5) * 0.000002,
      accuracyM: 4 + rand() * 2,
      speedMps: 1.4 + rand() * 2.2,
      clientTsMs: nowMs,
      mock: true,
      plant: autoPlant ? undefined : false,
    },
    nowMs,
  );

  if (hadOpenTrail && seat.mode === "safe" && seat.trail.length === 0) {
    raids.delete(keyOf(state, seatId));
  }

  return effects;
}

/** Forget bot memory for a lobby (rematch / delete). */
export function resetBotMemory(code: string) {
  for (const k of [...headings.keys()]) if (k.startsWith(`${code}#`)) headings.delete(k);
  for (const k of [...raids.keys()]) if (k.startsWith(`${code}#`)) raids.delete(k);
  for (const k of [...lastStepMs.keys()]) if (k.startsWith(`${code}#`)) lastStepMs.delete(k);
}

export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seatIsBot(seat: Seat): boolean {
  return seat.bot;
}
