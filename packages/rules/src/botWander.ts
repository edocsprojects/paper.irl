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
/** Waypoints closer than this count as reached (keeps corners crisp). */
const WAYPOINT_REACHED_M = 3;

/**
 * Street-grid bearing for a lobby (radians). Real players walk along streets,
 * so loops are blocks: straight legs with ~90° corners on this grid.
 */
function gridAngle(state: LobbyState): number {
  const key = `${state.arena.centerLat.toFixed(3)},${state.arena.centerLon.toFixed(3)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  // Mostly north–south grids, some cities sit at an angle.
  return (h & 3) === 0 ? (((h >>> 2) % 90) * Math.PI) / 180 : 0;
}

/** Offset `m` metres from `p` along grid bearing `a` (0 = east, π/2 = north). */
function along(p: LatLon, a: number, m: number): LatLon {
  return fromLocalM(p.lat, p.lon, Math.cos(a) * m, Math.sin(a) * m);
}

/**
 * Corners of a walk around the block, starting next to home: out along one
 * street, across, and partway back. Most raids are modest bites; some are
 * bold sweeps around a bigger block (more land, longer trail to cut) —
 * paper.io's risk/reward. Banking walks the last leg(s) home.
 */
function planLoop(state: LobbyState, home: LatLon, leashM: number, rand: () => number): LatLon[] {
  const bold = rand() < BOLD_RAID_CHANCE;
  const maxR = Math.max(24, Math.min(leashM * 0.8, state.arena.radiusM * 0.45));
  const out = Math.min(maxR, bold ? 50 + rand() * 50 : 30 + rand() * 20);
  const across = Math.min(maxR, bold ? 40 + rand() * 45 : 22 + rand() * 18);
  const g = gridAngle(state) + (Math.floor(rand() * 4) * Math.PI) / 2;
  const side = rand() < 0.5 ? 1 : -1;
  const perp = g + (side * Math.PI) / 2;
  // People don't walk perfect rectangles: corners land a few metres off.
  const wob = () => (rand() - 0.5) * 6;
  const a = along(along(home, g, out + wob()), perp, wob());
  const b = along(a, perp, across + wob());
  const pts = [a, b];
  if (bold && rand() < 0.5) {
    // Around a second block before heading back.
    pts.push(along(b, g + Math.PI, out * (0.3 + rand() * 0.3)));
    pts.push(along(pts[2]!, perp, across * (0.4 + rand() * 0.4)));
  } else {
    pts.push(along(b, g + Math.PI, out * (0.45 + rand() * 0.35)));
  }
  const inner = { ...state.arena, radiusM: state.arena.radiusM - 6 };
  return pts.map((p) => clampToArena(inner, p));
}

/**
 * Route along the grid: if the target is off-axis, aim first for the corner
 * of an L (walk down the street, then turn), like someone on sidewalks.
 */
function gridRoute(state: LobbyState, pos: LatLon, target: LatLon): LatLon {
  const g = gridAngle(state);
  const v = toLocalM(pos.lat, pos.lon, target.lat, target.lon);
  const u = v.x * Math.cos(g) + v.y * Math.sin(g);
  const w = -v.x * Math.sin(g) + v.y * Math.cos(g);
  if (Math.abs(u) < 8 || Math.abs(w) < 8) return target;
  // Longer leg first; the corner point stays fixed while we walk toward it.
  return Math.abs(u) >= Math.abs(w) ? along(pos, g, u) : along(pos, g + Math.PI / 2, w);
}
const STUCK_WINDOW_MS = 6000;
const STUCK_MIN_M = 4;

/** Bot memory is per lobby — seat ids restart at 1 in every lobby. */
const headings = new Map<string, number>();
const raids = new Map<string, RaidPlan>();
const keyOf = (state: LobbyState, id: SeatId) => `${state.code}#${id}`;

/** Real jog pace; lobby.speedScale multiplies it for demos. */
const BASE_SPEED_MPS = 3;
/** Turn rate: quick enough for street corners, never an instant snap. */
const MAX_TURN_RAD_PER_S = 3.6;
/** How fast a bot gets back up to pace after a corner or stop (m/s²). */
const ACCEL_MPS2 = 1.6;
const lastStepMs = new Map<string, number>();

/** Per-bot motion state: current speed, a pause (waiting to cross), pace drift. */
type Gait = { speed: number; pauseUntilMs: number; drift: number };
const gaits = new Map<string, Gait>();

function stepSeconds(state: LobbyState, seat: Seat, nowMs: number): number {
  const key = keyOf(state, seat.id);
  const last = lastStepMs.get(key);
  lastStepMs.set(key, nowMs);
  if (last === undefined) return 0.2;
  return Math.max(0.05, Math.min(0.5, (nowMs - last) / 1000));
}

/** Each bot has its own pace (brisk walker … runner) so they never move in lockstep. */
function paceMps(state: LobbyState, seat: Seat): number {
  const personal = 0.78 + ((seat.id * 7919) % 41) / 100; // 0.78–1.18
  return BASE_SPEED_MPS * personal * state.speedScale;
}

function gaitOf(state: LobbyState, seat: Seat): Gait {
  const key = keyOf(state, seat.id);
  let g = gaits.get(key);
  if (!g) {
    g = { speed: paceMps(state, seat) * 0.5, pauseUntilMs: 0, drift: 1 };
    gaits.set(key, g);
  }
  return g;
}

/** Stop for a moment (waiting at a crossing, catching breath) — in sim time. */
function maybePause(state: LobbyState, seat: Seat, rand: () => number, chance: number, nowMs: number) {
  if (rand() >= chance) return;
  const g = gaitOf(state, seat);
  g.pauseUntilMs = nowMs + (1200 + rand() * 2800) / Math.max(1, state.speedScale);
  g.speed = 0;
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
  const gait = gaitOf(state, seat);
  if (nowMs < gait.pauseUntilMs) return pos;
  const local = toLocalM(pos.lat, pos.lon, goal.lat, goal.lon);
  const dist = Math.hypot(local.x, local.y);
  const desired = Math.atan2(local.y, local.x);
  const current = headings.get(key) ?? desired;
  const turn = angleDiff(desired, current);
  const maxTurn = MAX_TURN_RAD_PER_S * dt;
  const heading = current + Math.max(-maxTurn, Math.min(maxTurn, turn));
  // Pace drifts a little over time; slow down through corners, then speed up.
  gait.drift = Math.max(0.85, Math.min(1.12, gait.drift + (rand() - 0.5) * 0.04 * dt * 5));
  const cruise = paceMps(state, seat) * gait.drift;
  const target = Math.abs(turn) > 0.6 ? cruise * 0.55 : cruise;
  const accel = ACCEL_MPS2 * state.speedScale * state.speedScale * dt;
  gait.speed = gait.speed < target ? Math.min(target, gait.speed + accel) : Math.max(target, gait.speed - accel * 2);
  const stepM = Math.min(Math.max(gait.speed, cruise * 0.3) * dt, Math.max(dist, 0.05));
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
  const reported =
    seat.position ??
    seat.respawnAt ??
    ({ lat: arena.centerLat, lon: arena.centerLon } as LatLon);
  // Steer from where the bot really is, not its noisy GPS fix (unless the
  // game moved it, e.g. a respawn or a clamp at the boundary).
  const truth = truths.get(keyOf(state, seat.id));
  const pos =
    truth && seat.position && haversineM(truth.lat, truth.lon, seat.position.lat, seat.position.lon) < 8
      ? truth
      : reported;

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
    return stepToward(state, seat, pos, gridRoute(state, pos, plan.goal), rand, nowMs);
  }

  if (seat.mode === "trailing" && seat.owned.length) {
    const plan = ensureRaid(state, seat, pos, rand, nowMs);
    const home = plan.home;
    // Walk the loop's waypoints; once it's done, head home to bank it.
    let toGoal = toLocalM(pos.lat, pos.lon, plan.goal.lat, plan.goal.lon);
    while (Math.hypot(toGoal.x, toGoal.y) < WAYPOINT_REACHED_M && plan.loopIdx < plan.loop.length) {
      plan.loopIdx++;
      maybePause(state, seat, rand, 0.06, nowMs); // waiting to cross at the corner
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
      // Walk home down the streets (an L), not as the crow flies.
      return stepToward(state, seat, pos, gridRoute(state, pos, homeEntry(state, seat, pos) ?? home), rand, nowMs);
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
  const key = keyOf(state, seatId);
  const pos = wanderStep(state, seat, rand, autoPlant, nowMs);
  truths.set(key, pos);
  const fix = gpsFix(state, key, pos, seat.mode === "safe" || seat.mode === "trailing", rand, nowMs);
  // Remember open trail so we only reset the raid after a bank — never while
  // still walking out of the starter (that trapped bots inside the blob).
  const hadOpenTrail = seat.trail.length > 0 || seat.mode === "trailing";

  const effects = applyFix(
    state,
    seatId,
    {
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: 4 + rand() * 4,
      speedMps: 1.4 + rand() * 2.2,
      clientTsMs: nowMs,
      mock: true,
      plant: autoPlant ? undefined : false,
    },
    nowMs,
  );

  if (hadOpenTrail && seat.mode === "safe" && seat.trail.length === 0) {
    raids.delete(keyOf(state, seatId));
    // Just banked: catch a breath / look around before heading out again.
    maybePause(state, seat, rand, 0.4, nowMs);
  }

  return effects;
}

/** Real phones wander a metre or two around the truth, slowly (not white noise). */
const GPS_SIGMA_M = 1.1;
const GPS_TAU_S = 4;
const truths = new Map<string, LatLon>();
const gpsNoise = new Map<string, { x: number; y: number; atMs: number }>();

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());
}

/** The fix a phone would report at `pos`: a correlated drift, kept inside the circle. */
function gpsFix(state: LobbyState, key: string, pos: LatLon, on: boolean, rand: () => number, nowMs: number): LatLon {
  let n = gpsNoise.get(key);
  if (!on) {
    gpsNoise.delete(key);
    return pos;
  }
  if (!n) n = { x: 0, y: 0, atMs: nowMs };
  // Wall-clock-ish: the drift changes with real seconds, not sim speed.
  const dt = Math.max(0, Math.min(1, (nowMs - n.atMs) / 1000 / Math.max(1, state.speedScale)));
  const k = dt / GPS_TAU_S;
  const kick = GPS_SIGMA_M * Math.sqrt(2 * k);
  n.x += -n.x * k + kick * gauss(rand);
  n.y += -n.y * k + kick * gauss(rand);
  n.atMs = nowMs;
  gpsNoise.set(key, n);
  const inner = { ...state.arena, radiusM: state.arena.radiusM - 1 };
  return clampToArena(inner, fromLocalM(pos.lat, pos.lon, n.x, n.y));
}

/** Forget bot memory for a lobby (rematch / delete). */
export function resetBotMemory(code: string) {
  for (const m of [gaits, truths, gpsNoise]) for (const k of [...m.keys()]) if (k.startsWith(`${code}#`)) m.delete(k);
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
