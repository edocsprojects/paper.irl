import {
  clampToArena,
  distanceToArenaCenterM,
  distanceToPolylineM,
  fromLocalM,
  haversineM,
  isInsideArena,
  toLocalM,
} from "./geo.js";
import {
  bufferPolyline,
  circleLocal,
  differenceSafe,
  dropSlivers,
  fillHoles,
  intersectionSafe,
  multiAreaLocal,
  nearestBoundaryPoint,
  pointInTerritory,
  segmentHitsPolyline,
  simplifyMulti,
  territoryAreaM2,
  territoryFromLocal,
  territoryToLocal,
  toLocalPair,
  unionAll,
  type MultiPolygon,
  type Origin,
  type Pair,
} from "./territory.js";
import type {
  Arena,
  DeathReason,
  Effect,
  Fix,
  LatLon,
  LobbyState,
  Seat,
  SeatId,
} from "./types.js";

/** Vivid paper.io-style base colours (zone fill; border/trail shades derive from these). */
const COLORS = [
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

/** A fix this close (m) outside your border still counts as "home". */
const EDGE_SLACK_M = 2;
/** Larger GPS jumps are not swept for trail crossings (teleport / re-acquire). */
const MAX_SWEEP_STEP_M = 60;
const ARENA_SIDES = 96;
/** Clear ground (m) every new starter keeps from anyone else's land / body. */
const SPAWN_GAP_M = 8;
/** Bites smaller than this left behind after a steal are dropped (no confetti). */
const MIN_FRAGMENT_M2 = 30;
const FEED_MAX = 12;
const STARTER_SIDES = 24;

export function createLobby(
  code: string,
  arena: Arena,
  opts?: { durationMs?: number; maxSeats?: number; speedScale?: number },
): LobbyState {
  return {
    code,
    phase: "open",
    durationMs: opts?.durationMs ?? 15 * 60 * 1000,
    startedAtMs: null,
    endsAtMs: null,
    arena,
    seats: new Map(),
    nextSeatId: 1,
    /** Touch radius for cutting a trail (≈ phone GPS error, not a hitbox the size of a road). */
    cutProximityM: 4,
    plantDwellMs: 0,
    /** Walk into your spawn ring (its radius) and you're planted. */
    plantRadiusM: arena.starterRadiusM,
    pathWidthM: arena.pathWidthM,
    maxSeats: opts?.maxSeats ?? 8,
    trailSampleM: 1,
    ghostMs: 3000,
    boundaryMode: "clamp",
    rematchReady: new Set(),
    feed: [],
    notices: [],
    pops: [],
    speedScale: Math.max(0.5, Math.min(4, opts?.speedScale ?? 1)),
  };
}

export function joinLobby(
  state: LobbyState,
  nickname: string,
  opts?: { bot?: boolean },
): { seat: Seat; effects: Effect[] } {
  if (state.phase !== "open") {
    throw new Error("lobby_not_open");
  }
  if (state.seats.size >= state.maxSeats) {
    throw new Error("lobby_full");
  }
  let name = nickname.trim() || `Player ${state.nextSeatId}`;
  const taken = new Set([...state.seats.values()].map((s) => s.nickname));
  if (taken.has(name)) {
    let i = 2;
    while (taken.has(`${name}${i}`)) i++;
    name = `${name}${i}`;
  }
  const id = state.nextSeatId++;
  const seat: Seat = {
    id,
    nickname: name,
    mode: "joining",
    color: COLORS[(id - 1) % COLORS.length]!,
    owned: [],
    trail: [],
    position: null,
    respawnAt: null,
    areaM2: 0,
    ghostUntilMs: null,
    bot: opts?.bot ?? false,
    lastDeath: null,
  };
  state.seats.set(id, seat);
  return { seat, effects: [] };
}

function minStarterSep(state: LobbyState): number {
  return state.arena.starterRadiusM * 2 + SPAWN_GAP_M;
}

/**
 * Go live. Seats whose GPS position is already known (fixes sent while the
 * lobby was open) get their starter marker where they stand. Seats with no
 * position yet (bots, or a phone still acquiring GPS) get a ring slot; a
 * human's marker then follows their first real fix.
 */
export function startLobby(state: LobbyState, nowMs: number): Effect[] {
  if (state.phase !== "open") throw new Error("bad_phase");
  if (state.seats.size < 1) throw new Error("need_players");
  state.phase = "live";
  state.startedAtMs = nowMs;
  state.endsAtMs = nowMs + state.durationMs;
  const effects: Effect[] = [{ kind: "phase", phase: "live" }];
  const placed: LatLon[] = [];
  const minSepM = minStarterSep(state);

  const all = [...state.seats.values()];
  const located = all.filter((s) => s.position);
  const unlocated = all.filter((s) => !s.position);

  for (const seat of located) {
    const at = pickNearestSafePoint(state, seat.position, seat.id, {
      placedStarters: placed,
      minStarterSepM: minSepM,
      exceptSeat: seat.id,
    });
    placed.push(at);
    seat.respawnAt = at;
    seat.mode = "toPlant";
    effects.push({ kind: "respawnAssigned", seatId: seat.id, at });
  }

  // Seats without GPS (bots) are spread evenly over the whole arena on a
  // sunflower spiral — not a ring around whoever happens to be in the middle.
  const usable = Math.max(10, state.arena.radiusM - state.arena.starterRadiusM - 12);
  const slots = Math.max(8, all.length * 2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rot = (hashCode(state.code) % 6283) / 1000;
  const spiral: LatLon[] = [];
  for (let i = 0; i < slots; i++) {
    const r = usable * Math.sqrt((i + 0.5) / slots);
    const ang = i * golden + rot;
    spiral.push(
      fromLocalM(state.arena.centerLat, state.arena.centerLon, Math.cos(ang) * r, Math.sin(ang) * r),
    );
  }
  // Interleave outer/inner slots so a few bots still spread edge-to-centre.
  const order = spiral
    .map((p, i) => ({ p, k: (i * 0.618034) % 1 }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.p);
  for (const seat of unlocated) {
    let at = order.find((p) => starterPlacementOk(state, p, placed, seat.id, minSepM)) ?? null;
    at ??= pickNearestSafePoint(state, null, seat.id, {
      placedStarters: placed,
      minStarterSepM: minSepM,
      exceptSeat: seat.id,
    });
    placed.push(at);
    seat.respawnAt = at;
    seat.mode = "toPlant";
    effects.push({ kind: "respawnAssigned", seatId: seat.id, at });
  }
  return effects;
}

export function endLobby(state: LobbyState): Effect[] {
  state.phase = "ended";
  state.rematchReady = new Set();
  for (const seat of state.seats.values()) {
    seat.trail = [];
    if (seat.mode === "trailing") seat.mode = "safe";
  }
  return [{ kind: "phase", phase: "ended" }];
}

/**
 * Mark a seat ready to play again with the same lobby roster.
 * Does not start the rematch — call startRematch when the host (or auto) is ready.
 */
export function markRematchReady(
  state: LobbyState,
  seatId: SeatId,
): Effect[] {
  if (state.phase !== "ended") throw new Error("bad_phase");
  if (!state.seats.has(seatId)) throw new Error("no_seat");
  state.rematchReady.add(seatId);
  return [
    {
      kind: "rematchReady",
      seatId,
      readyIds: [...state.rematchReady],
    },
  ];
}

/**
 * Reset territory and start a new timed match with the same seats/nicknames.
 * Requires ended phase and at least one rematch-ready seat (caller enforces host policy).
 * Positions are kept so everyone respawns where they are standing.
 */
export function startRematch(state: LobbyState, nowMs: number): Effect[] {
  if (state.phase !== "ended") throw new Error("bad_phase");
  if (state.seats.size < 1) throw new Error("need_players");
  if (state.rematchReady.size < 1) throw new Error("need_rematch_ready");

  for (const seat of state.seats.values()) {
    seat.owned = [];
    seat.trail = [];
    seat.respawnAt = null;
    seat.areaM2 = 0;
    seat.ghostUntilMs = null;
    seat.lastDeath = null;
    seat.mode = "joining";
  }
  state.rematchReady = new Set();
  state.feed = [];
  state.notices = [];
  state.pops = [];
  // Re-open so startLobby's phase guard accepts the rematch.
  state.phase = "open";
  state.startedAtMs = null;
  state.endsAtMs = null;
  return startLobby(state, nowMs);
}

export function topScores(state: LobbyState, n = 3): Seat[] {
  return [...state.seats.values()]
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, n);
}

function hashCode(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function originOf(state: LobbyState): Origin {
  return { lat: state.arena.centerLat, lon: state.arena.centerLon };
}

const arenaPolyCache = new Map<string, MultiPolygon>();
function arenaPoly(state: LobbyState): MultiPolygon {
  const a = state.arena;
  const key = `${a.centerLat},${a.centerLon},${a.radiusM}`;
  let poly = arenaPolyCache.get(key);
  if (!poly) {
    poly = [circleLocal(0, 0, a.radiusM, ARENA_SIDES)];
    arenaPolyCache.set(key, poly);
  }
  return poly;
}

function recomputeArea(state: LobbyState, seat: Seat) {
  seat.areaM2 = territoryAreaM2(originOf(state), seat.owned);
}

function isAlive(seat: Seat): boolean {
  return seat.mode === "safe" || seat.mode === "trailing";
}

function pointInOwned(seat: Seat, p: LatLon, edgeSlackM = EDGE_SLACK_M): boolean {
  return pointInTerritory(p, seat.owned, edgeSlackM);
}

/** Trail including the live head (last fix may not have been sampled yet). */
function liveTrail(seat: Seat): LatLon[] {
  const tip = seat.trail[seat.trail.length - 1];
  const head = seat.position;
  if (head && tip && (tip.lat !== head.lat || tip.lon !== head.lon)) {
    return [...seat.trail, head];
  }
  return seat.trail;
}

function isPointContested(
  state: LobbyState,
  p: LatLon,
  exceptSeat: SeatId | null,
): boolean {
  for (const s of state.seats.values()) {
    if (exceptSeat !== null && s.id === exceptSeat) continue;
    if (pointInOwned(s, p, 2)) return true;
    if (s.mode === "trailing" && s.trail.length >= 1) {
      if (distanceToPolylineM(p, liveTrail(s)) <= state.cutProximityM) return true;
    }
  }
  return false;
}

/** True if a starter disk centred at `p` stays in the arena and clear of others' land/markers. */
function starterPlacementOk(
  state: LobbyState,
  p: LatLon,
  placed: LatLon[],
  exceptSeat: SeatId | null,
  minSepM: number,
): boolean {
  const R = state.arena.starterRadiusM;
  if (!isInsideArena(state.arena, p, -(R + 2))) return false;
  if (isPointContested(state, p, exceptSeat)) return false;
  for (const q of placed) {
    if (haversineM(p.lat, p.lon, q.lat, q.lon) < minSepM) return false;
  }
  for (const s of state.seats.values()) {
    if (exceptSeat !== null && s.id === exceptSeat) continue;
    if (s.respawnAt && (s.mode === "toPlant" || s.mode === "joining" || s.mode === "ghost")) {
      if (haversineM(p.lat, p.lon, s.respawnAt.lat, s.respawnAt.lon) < minSepM) {
        return false;
      }
    }
    // Whole disk + a visible gap must miss everyone else's land…
    if (pointInOwned(s, p, R + SPAWN_GAP_M)) return false;
    // …their open trail (never spawn on top of a line)…
    if (s.mode === "trailing" && s.trail.length >= 1) {
      if (distanceToPolylineM(p, liveTrail(s)) <= R + SPAWN_GAP_M) return false;
    }
    // …and where living players are standing.
    if (isAlive(s) && s.position) {
      if (haversineM(p.lat, p.lon, s.position.lat, s.position.lon) <= R + SPAWN_GAP_M) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Nearest safe starter centre to `from` (the player's own position when
 * known). `from` itself is tried first, so an uncontested player spawns
 * exactly where they stand.
 */
export function pickNearestSafePoint(
  state: LobbyState,
  from: LatLon | null,
  seed = 1,
  opts?: {
    placedStarters?: LatLon[];
    minStarterSepM?: number;
    exceptSeat?: SeatId;
    /** Keep the result at least `minFromM` from this point (e.g. where you died). */
    avoid?: LatLon | null;
    minFromM?: number;
  },
): LatLon {
  const arena = state.arena;
  const rand = mulberry(seed);
  const placed = opts?.placedStarters ?? [];
  const minSep = opts?.minStarterSepM ?? minStarterSep(state);
  const except = opts?.exceptSeat ?? null;
  const avoid = opts?.avoid ?? null;
  const minFrom = opts?.minFromM ?? 0;
  const ok = (p: LatLon) =>
    starterPlacementOk(state, p, placed, except, minSep) &&
    (!avoid || haversineM(p.lat, p.lon, avoid.lat, avoid.lon) >= minFrom);
  const inner = Math.max(1, arena.radiusM - arena.starterRadiusM - 3);
  const origin = clampToArena(
    { ...arena, radiusM: inner },
    from ??
      fromLocalM(
        arena.centerLat,
        arena.centerLon,
        (rand() - 0.5) * arena.radiusM * 0.6,
        (rand() - 0.5) * arena.radiusM * 0.6,
      ),
  );
  if (ok(origin)) return origin;

  const candidates: LatLon[] = [];
  const o = toLocalM(arena.centerLat, arena.centerLon, origin.lat, origin.lon);
  const push = (x: number, y: number) =>
    candidates.push(fromLocalM(arena.centerLat, arena.centerLon, x, y));
  for (let r = 4; r <= 60; r += 4) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2 + seed * 0.01;
      push(o.x + Math.cos(ang) * r, o.y + Math.sin(ang) * r);
    }
  }
  for (let r = 70; r <= arena.radiusM * 2; r += 15) {
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2 + seed * 0.02;
      push(o.x + Math.cos(ang) * r, o.y + Math.sin(ang) * r);
    }
  }
  for (let i = 0; i < 48; i++) {
    const ang = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * inner;
    push(Math.cos(ang) * r, Math.sin(ang) * r);
  }
  const ranked = candidates
    .filter((p) => isInsideArena(arena, p, -(arena.starterRadiusM + 2)))
    .map((p) => ({ p, d: haversineM(origin.lat, origin.lon, p.lat, p.lon) }))
    .sort((a, b) => a.d - b.d);
  for (const { p } of ranked) {
    if (ok(p)) return p;
  }
  for (const { p } of ranked) {
    if (starterPlacementOk(state, p, placed, except, minSep)) return p;
  }
  return ranked[0]?.p ?? origin;
}

/**
 * Remove `claim` from every other seat. A seat left with no land is
 * eliminated (paper.io: lose all territory → you die).
 */
function takeLand(
  state: LobbyState,
  claimant: Seat,
  claim: MultiPolygon,
  nowMs: number,
): Effect[] {
  const o = originOf(state);
  const effects: Effect[] = [];
  for (const other of state.seats.values()) {
    if (other.id === claimant.id || other.owned.length === 0) continue;
    const theirs = territoryToLocal(o, other.owned);
    const lost = multiAreaLocal(intersectionSafe(theirs, claim));
    if (lost < 0.5) continue;
    const rem = dropSlivers(differenceSafe(theirs, claim), MIN_FRAGMENT_M2);
    other.owned = territoryFromLocal(o, rem);
    recomputeArea(state, other);
    effects.push({ kind: "landLost", seatId: other.id, byId: claimant.id, lostM2: lost });
    state.notices.push({ atMs: nowMs, kind: "landLost", seatId: other.id, byId: claimant.id, lostM2: lost });
    if (state.notices.length > FEED_MAX) state.notices.splice(0, state.notices.length - FEED_MAX);
    if (other.owned.length === 0 && isAlive(other)) {
      effects.push(...wipeSeat(state, other, claimant.id, "captured", nowMs));
    }
  }
  return effects;
}

function plantStarter(
  state: LobbyState,
  seat: Seat,
  at: LatLon,
  nowMs: number,
): Effect[] {
  const o = originOf(state);
  const c = toLocalPair(o, at);
  let disk = intersectionSafe(
    [circleLocal(c[0], c[1], state.arena.starterRadiusM, STARTER_SIDES)],
    arenaPoly(state),
  );
  // Never paint over land someone already holds.
  const others = unionAll(
    [...state.seats.values()]
      .filter((s) => s.id !== seat.id && s.owned.length)
      .map((s) => territoryToLocal(o, s.owned)),
  );
  disk = dropSlivers(differenceSafe(disk, others), 1);
  if (!disk.length) return [];
  seat.owned = territoryFromLocal(o, disk);
  seat.trail = [];
  seat.mode = "safe";
  seat.respawnAt = null;
  seat.ghostUntilMs = null;
  recomputeArea(state, seat);
  state.pops.push({ atMs: nowMs, seatId: seat.id, at: { ...at } });
  if (state.pops.length > FEED_MAX) state.pops.splice(0, state.pops.length - FEED_MAX);
  return [{ kind: "planted", seatId: seat.id, ring: seat.owned[0]![0]! }];
}

/** Close the loop: trail corridor ∪ land, then fill everything enclosed. */
function bankTrail(
  state: LobbyState,
  seat: Seat,
  pos: LatLon,
  nowMs: number,
): Effect[] {
  const o = originOf(state);
  const before = seat.areaM2;
  const mine = territoryToLocal(o, seat.owned);
  const path = [...seat.trail, pos].map((p) => toLocalPair(o, p));
  const corridor = bufferPolyline(path, state.pathWidthM / 2);
  let next = fillHoles(unionAll([mine, corridor]));
  next = intersectionSafe(next, arenaPoly(state));
  next = dropSlivers(simplifyMulti(next, 0.8), 1);
  if (!next.length) next = mine;
  seat.owned = territoryFromLocal(o, next);
  seat.trail = [];
  seat.mode = "safe";
  recomputeArea(state, seat);
  const effects: Effect[] = [
    {
      kind: "banked",
      seatId: seat.id,
      gainedM2: Math.max(0, seat.areaM2 - before),
      areaM2: seat.areaM2,
    },
  ];
  effects.push(...takeLand(state, seat, next, nowMs));
  return effects;
}

function wipeSeat(
  state: LobbyState,
  victim: Seat,
  byId: SeatId,
  reason: DeathReason,
  nowMs: number,
): Effect[] {
  if (!isAlive(victim)) return [];
  // Land goes neutral (not to the cutter); trail clears. No teleport: the
  // player stays where they physically are and respawns near there.
  victim.owned = [];
  victim.trail = [];
  victim.areaM2 = 0;
  victim.mode = "ghost";
  victim.ghostUntilMs = nowMs + state.ghostMs;
  victim.lastDeath = {
    byId,
    reason,
    atMs: nowMs,
    at: victim.position ? { ...victim.position } : null,
  };
  // Respawn ring is shown right away (even while a ghost), away from the body.
  victim.respawnAt = pickRespawn(state, victim);
  state.feed.push({
    atMs: nowMs,
    victimId: victim.id,
    byId,
    reason,
    at: victim.position ? { ...victim.position } : null,
  });
  if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
  return [{ kind: "cut", victimId: victim.id, byId, reason }];
}

/** Moving from `from` to `to` touches someone else's open trail → they die. */
function cutTouchedTrails(
  state: LobbyState,
  mover: Seat,
  from: LatLon | null,
  to: LatLon,
  nowMs: number,
): Effect[] {
  const o = originOf(state);
  const effects: Effect[] = [];
  for (const other of state.seats.values()) {
    if (other.id === mover.id || other.mode !== "trailing") continue;
    const line = liveTrail(other);
    if (line.length < 2) continue;
    let hit = distanceToPolylineM(to, line) <= state.cutProximityM;
    if (!hit && from) {
      hit = segmentHitsPolyline(
        toLocalPair(o, from),
        toLocalPair(o, to),
        line.map((p) => toLocalPair(o, p)),
      );
    }
    if (hit) effects.push(...wipeSeat(state, other, mover.id, "cut", nowMs));
  }
  return effects;
}

/**
 * After a death: a clear spawn ring ~2 radii from where you fell (never within
 * 1.6 R), so respawning means walking into it — never "already standing in it".
 */
function pickRespawn(state: LobbyState, seat: Seat): LatLon {
  const R = state.arena.starterRadiusM;
  const died = seat.lastDeath?.at ?? seat.position;
  if (!died) return pickNearestSafePoint(state, null, seat.id * 23, { exceptSeat: seat.id });
  // Head away from whoever cut you (or the arena edge), with a little spread.
  const cutter = seat.lastDeath ? state.seats.get(seat.lastDeath.byId) : undefined;
  const from =
    cutter && cutter.id !== seat.id && cutter.position
      ? cutter.position
      : { lat: state.arena.centerLat, lon: state.arena.centerLon };
  const v = toLocalM(from.lat, from.lon, died.lat, died.lon);
  let ang = Math.hypot(v.x, v.y) > 1 ? Math.atan2(v.y, v.x) : (seat.id * 2.399) % (Math.PI * 2);
  if (!cutter || cutter.id === seat.id) ang += Math.PI; // no cutter position: aim inward
  ang += (((seat.id * 7 + (seat.lastDeath?.atMs ?? 0)) % 100) / 100 - 0.5) * 0.8;
  const preferred = fromLocalM(died.lat, died.lon, Math.cos(ang) * 2 * R, Math.sin(ang) * 2 * R);
  return pickNearestSafePoint(state, preferred, seat.id * 29 + 3, {
    exceptSeat: seat.id,
    avoid: died,
    minFromM: 1.6 * R,
  });
}

/**
 * First spawn: the marker follows you (you plant where you stand).
 * Respawn: the ring stays put unless it becomes unsafe.
 */
function updateSpawnMarker(state: LobbyState, seat: Seat, pos: LatLon): Effect[] {
  const cur = seat.respawnAt;
  if (seat.lastDeath) {
    if (cur && starterPlacementOk(state, cur, [], seat.id, minStarterSep(state))) return [];
    const at = pickRespawn(state, seat);
    seat.respawnAt = at;
    return [{ kind: cur ? "respawnMoved" : "respawnAssigned", seatId: seat.id, at }];
  }
  const near = pickNearestSafePoint(state, pos, seat.id * 19 + 7, {
    exceptSeat: seat.id,
  });
  if (!cur) {
    seat.respawnAt = near;
    return [{ kind: "respawnAssigned", seatId: seat.id, at: near }];
  }
  const curOk = starterPlacementOk(state, cur, [], seat.id, minStarterSep(state));
  const dCur = haversineM(pos.lat, pos.lon, cur.lat, cur.lon);
  const dNear = haversineM(pos.lat, pos.lon, near.lat, near.lon);
  if (!curOk || (dNear + 0.5 < dCur && haversineM(cur.lat, cur.lon, near.lat, near.lon) > 1)) {
    seat.respawnAt = near;
    return [{ kind: "respawnMoved", seatId: seat.id, at: near }];
  }
  return [];
}

/**
 * Apply one GPS fix for a seat. Server authority entry point (freeplay).
 */
export function applyFix(
  state: LobbyState,
  seatId: SeatId,
  fix: Fix,
  nowMs: number,
): Effect[] {
  const effects: Effect[] = [];
  if (state.phase === "ended") {
    return [{ kind: "rejected", seatId, reason: "ended" }];
  }
  if (state.phase === "live" && state.endsAtMs !== null && nowMs >= state.endsAtMs) {
    return endLobby(state);
  }
  const seat = state.seats.get(seatId);
  if (!seat) return [{ kind: "rejected", seatId, reason: "no_seat" }];
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) {
    return [{ kind: "rejected", seatId, reason: "bad_fix" }];
  }
  if (fix.accuracyM > 40) {
    return [{ kind: "rejected", seatId, reason: "accuracy" }];
  }
  if (fix.speedMps > 8) {
    return [{ kind: "rejected", seatId, reason: "speed" }];
  }

  const raw: LatLon = { lat: fix.lat, lon: fix.lon };
  const outside = !isInsideArena(state.arena, raw);
  const pos = clampToArena(state.arena, raw);
  const prev = seat.position;
  seat.position = pos;

  // Pre-match: remember where the player stands so their starter spawns there.
  if (state.phase !== "live") {
    return [{ kind: "rejected", seatId, reason: "not_live" }];
  }
  if (outside) effects.push({ kind: "boundaryPush", seatId, at: pos });

  if (seat.mode === "ghost") {
    if (seat.ghostUntilMs !== null && nowMs < seat.ghostUntilMs) return effects;
    seat.mode = "toPlant";
    seat.ghostUntilMs = null;
  }

  // Plant — fix.plant===false (not armed yet) never plants; true/undefined plants
  // as soon as the player is within plantRadius of their marker.
  if (seat.mode === "toPlant" || seat.mode === "joining") {
    effects.push(...updateSpawnMarker(state, seat, pos));
    const at = seat.respawnAt;
    if (
      at &&
      fix.plant !== false &&
      haversineM(pos.lat, pos.lon, at.lat, at.lon) <= state.plantRadiusM &&
      starterPlacementOk(state, at, [], seat.id, minStarterSep(state))
    ) {
      effects.push(...plantStarter(state, seat, at, nowMs));
    }
    return effects;
  }

  if (!isAlive(seat)) return effects;

  const sweepFrom =
    prev && haversineM(prev.lat, prev.lon, pos.lat, pos.lon) <= MAX_SWEEP_STEP_M
      ? prev
      : null;

  // Touching anyone's open trail (even from inside your own land) cuts them.
  effects.push(...cutTouchedTrails(state, seat, sweepFrom, pos, nowMs));

  if (seat.owned.length === 0) {
    effects.push(...wipeSeat(state, seat, seat.id, "captured", nowMs));
    return effects;
  }

  const onOwn = pointInOwned(seat, pos);

  if (seat.mode === "safe") {
    if (!onOwn) {
      seat.mode = "trailing";
      // Anchor the trail inside home so the bank corridor joins the land.
      const anchor =
        sweepFrom && pointInOwned(seat, sweepFrom)
          ? { ...sweepFrom }
          : nearestBoundaryPoint(originOf(state), seat.owned, pos) ?? { ...pos };
      seat.trail =
        haversineM(anchor.lat, anchor.lon, pos.lat, pos.lon) >= 0.25
          ? [anchor, pos]
          : [anchor, fromLocalM(pos.lat, pos.lon, 0.6, 0)];
      effects.push({ kind: "trailOpen", seatId });
      for (const p of seat.trail) {
        effects.push({ kind: "trailExtend", seatId, point: p });
      }
    }
    return effects;
  }

  // Trailing
  if (onOwn) {
    effects.push(...bankTrail(state, seat, pos, nowMs));
    return effects;
  }

  const last = seat.trail[seat.trail.length - 1];
  // Sample spacing grows with GPS error so standing still doesn't scribble.
  const minStep = Math.max(state.trailSampleM, Math.min(fix.accuracyM * 0.3, 3));
  if (last && haversineM(last.lat, last.lon, pos.lat, pos.lon) < minStep) {
    return effects;
  }
  // Crossing your own trail is allowed (no self-cut) — the loop just banks bigger.
  seat.trail.push(pos);
  effects.push({ kind: "trailExtend", seatId, point: pos });
  return effects;
}

/** Tick lobby clock; end if past endsAt. Ghosts become respawn-eligible. */
export function tickLobby(state: LobbyState, nowMs: number): Effect[] {
  const effects: Effect[] = [];
  if (state.phase === "live" && state.endsAtMs !== null && nowMs >= state.endsAtMs) {
    return endLobby(state);
  }
  if (state.phase !== "live") return effects;
  for (const seat of state.seats.values()) {
    if (seat.mode === "ghost" && seat.ghostUntilMs !== null && nowMs >= seat.ghostUntilMs) {
      seat.mode = "toPlant";
      seat.ghostUntilMs = null;
      if (seat.position) effects.push(...updateSpawnMarker(state, seat, seat.position));
    } else if ((seat.mode === "toPlant" || seat.mode === "ghost") && seat.respawnAt) {
      const pos = seat.position ?? seat.respawnAt;
      effects.push(...updateSpawnMarker(state, seat, pos));
    }
  }
  return effects;
}

export function seatPublicView(seat: Seat) {
  return {
    id: seat.id,
    nickname: seat.nickname,
    mode: seat.mode,
    color: seat.color,
    areaM2: seat.areaM2,
    trail: seat.trail.map((p) => ({ ...p })),
    owned: seat.owned.map((poly) => poly.map((ring) => ring.map((p) => ({ ...p })))),
    position: seat.position ? { ...seat.position } : null,
    respawnAt: seat.respawnAt ? { ...seat.respawnAt } : null,
    ghostUntilMs: seat.ghostUntilMs,
    bot: seat.bot,
    lastDeath: seat.lastDeath ? { ...seat.lastDeath } : null,
  };
}

/** Debug helper: how far a seat is from arena center. */
export function seatArenaDistM(state: LobbyState, seatId: SeatId): number | null {
  const seat = state.seats.get(seatId);
  if (!seat?.position) return null;
  return distanceToArenaCenterM(state.arena, seat.position);
}

/** Share of the arena a seat holds (0–100). */
export function seatSharePct(state: LobbyState, seat: Seat): number {
  const total = Math.PI * state.arena.radiusM ** 2;
  return total > 0 ? (seat.areaM2 / total) * 100 : 0;
}
