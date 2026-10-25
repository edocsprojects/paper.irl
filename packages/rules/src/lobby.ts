import {
  circleRing,
  clampToArena,
  distanceToArenaCenterM,
  distanceToPolylineM,
  distanceToRingEdgeM,
  fromLocalM,
  haversineM,
  isInsideArena,
  mergeRingsToOne,
  pointInRing,
  polylineLengthM,
  ringAreaM2,
  ringCentroid,
  toLocalM,
} from "./geo.js";
import type {
  Arena,
  Effect,
  Fix,
  LatLon,
  LobbyState,
  Seat,
  SeatId,
} from "./types.js";

const COLORS = [
  "#e63946",
  "#457b9d",
  "#2a9d8f",
  "#e9c46a",
  "#9b5de5",
  "#00bbf9",
  "#f15bb5",
  "#00f5d4",
];

export function createLobby(
  code: string,
  arena: Arena,
  opts?: { durationMs?: number; maxSeats?: number },
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
    cutProximityM: 15,
    plantDwellMs: 2000,
    plantRadiusM: 20,
    pathWidthM: arena.pathWidthM,
    maxSeats: opts?.maxSeats ?? 8,
    /** Dense enough that open trails paint quickly at walk/jog step size. */
    trailSampleM: 1.2,
    boundaryMode: "clamp",
    rematchReady: new Set(),
  };
}

export function joinLobby(
  state: LobbyState,
  nickname: string,
): { seat: Seat; effects: Effect[] } {
  if (state.phase !== "open") {
    throw new Error("lobby_not_open");
  }
  if (state.seats.size >= state.maxSeats) {
    throw new Error("lobby_full");
  }
  let name = nickname.trim() || "Player";
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
  };
  state.seats.set(id, seat);
  return { seat, effects: [] };
}

export function startLobby(state: LobbyState, nowMs: number): Effect[] {
  if (state.phase !== "open") throw new Error("bad_phase");
  if (state.seats.size < 1) throw new Error("need_players");
  state.phase = "live";
  state.startedAtMs = nowMs;
  state.endsAtMs = nowMs + state.durationMs;
  const effects: Effect[] = [{ kind: "phase", phase: "live" }];
  for (const seat of state.seats.values()) {
    const at = pickNearestSafePoint(state, null, randomSeed(seat.id));
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
 */
export function startRematch(state: LobbyState, nowMs: number): Effect[] {
  if (state.phase !== "ended") throw new Error("bad_phase");
  if (state.seats.size < 1) throw new Error("need_players");
  if (state.rematchReady.size < 1) throw new Error("need_rematch_ready");

  for (const seat of state.seats.values()) {
    seat.owned = [];
    seat.trail = [];
    seat.position = null;
    seat.respawnAt = null;
    seat.areaM2 = 0;
    seat.ghostUntilMs = null;
    seat.mode = "joining";
  }
  state.rematchReady = new Set();
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

function randomSeed(n: number) {
  return (n * 1103515245 + 12345) >>> 0;
}

function mulberry(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function recomputeArea(seat: Seat, pathWidthM: number) {
  let area = 0;
  for (const ring of seat.owned) {
    area += ringAreaM2(ring);
  }
  // Open trail does not score until banked.
  void pathWidthM;
  seat.areaM2 = area;
}

function pointInOwned(seat: Seat, p: LatLon, edgeSlackM = 3): boolean {
  for (const ring of seat.owned) {
    if (pointInRing(p, ring)) return true;
    if (distanceToRingEdgeM(p, ring) <= edgeSlackM) return true;
  }
  return false;
}

function isPointContested(
  state: LobbyState,
  p: LatLon,
  exceptSeat: SeatId | null,
): boolean {
  for (const s of state.seats.values()) {
    if (exceptSeat !== null && s.id === exceptSeat) continue;
    if (pointInOwned(s, p, 2)) return true;
    if (s.mode === "trailing" && s.trail.length >= 2) {
      if (distanceToPolylineM(p, s.trail) <= state.cutProximityM) return true;
    }
  }
  return false;
}

/**
 * Nearest safe freeplay spawn inside the arena (neutral, clear of trails).
 */
export function pickNearestSafePoint(
  state: LobbyState,
  from: LatLon | null,
  seed = 1,
): LatLon {
  const arena = state.arena;
  const rand = mulberry(seed);
  const origin =
    from ??
    fromLocalM(
      arena.centerLat,
      arena.centerLon,
      (rand() - 0.5) * arena.radiusM * 0.6,
      (rand() - 0.5) * arena.radiusM * 0.6,
    );

  const candidates: LatLon[] = [origin];
  // Spiral + random samples across the circle
  for (let i = 0; i < 48; i++) {
    const ang = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * arena.radiusM * 0.92;
    candidates.push(
      fromLocalM(arena.centerLat, arena.centerLon, Math.cos(ang) * r, Math.sin(ang) * r),
    );
  }
  for (let ring = 1; ring <= 12; ring++) {
    const rad = ring * 35;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2 + seed * 0.01;
      const local = toLocalM(arena.centerLat, arena.centerLon, origin.lat, origin.lon);
      candidates.push(
        fromLocalM(
          arena.centerLat,
          arena.centerLon,
          local.x + Math.cos(ang) * rad,
          local.y + Math.sin(ang) * rad,
        ),
      );
    }
  }

  const ranked = candidates
    .filter((p) => isInsideArena(arena, p, -8))
    .sort(
      (a, b) =>
        haversineM(origin.lat, origin.lon, a.lat, a.lon) -
        haversineM(origin.lat, origin.lon, b.lat, b.lon),
    );

  for (const p of ranked) {
    if (!isPointContested(state, p, null)) return p;
  }
  // Last resort: any in-bounds point
  return ranked[0] ?? clampToArena(arena, origin);
}

function grantStarter(state: LobbyState, seat: Seat, at: LatLon): LatLon[] {
  const ring = circleRing(at, state.arena.starterRadiusM, 16);
  seat.owned = [ring];
  recomputeArea(seat, state.pathWidthM);
  return ring;
}

function stealOverlapping(state: LobbyState, claimant: Seat, newRing: LatLon[]) {
  for (const other of state.seats.values()) {
    if (other.id === claimant.id) continue;
    const kept: LatLon[][] = [];
    let changed = false;
    for (const ring of other.owned) {
      const c = ringCentroid(ring);
      if (pointInRing(c, newRing)) {
        changed = true;
        continue;
      }
      kept.push(ring);
    }
    if (changed) {
      other.owned = kept;
      recomputeArea(other, state.pathWidthM);
    }
  }
}

function wipeSeat(
  state: LobbyState,
  victim: Seat,
  byId: SeatId,
  nowMs: number,
): Effect[] {
  const near = victim.position;
  const effects: Effect[] = [{ kind: "cut", victimId: victim.id, byId }];
  victim.owned = [];
  victim.trail = [];
  victim.areaM2 = 0;
  victim.mode = "ghost";
  victim.ghostUntilMs = nowMs + 3000;
  const at = pickNearestSafePoint(state, near, victim.id * 17);
  victim.respawnAt = at;
  victim.mode = "toPlant";
  effects.push({ kind: "respawnAssigned", seatId: victim.id, at });
  return effects;
}

function ensureRespawnSafe(state: LobbyState, seat: Seat): Effect[] {
  if (seat.respawnAt === null) return [];
  if (!isPointContested(state, seat.respawnAt, seat.id)) return [];
  const at = pickNearestSafePoint(state, seat.respawnAt, seat.id * 31);
  seat.respawnAt = at;
  return [{ kind: "respawnMoved", seatId: seat.id, at }];
}

function appendTrail(state: LobbyState, seat: Seat, p: LatLon): Effect | null {
  const last = seat.trail[seat.trail.length - 1];
  if (last) {
    const d = haversineM(last.lat, last.lon, p.lat, p.lon);
    if (d < state.trailSampleM) {
      // Still move the tip for cut detection feel
      seat.trail[seat.trail.length - 1] = p;
      return null;
    }
  }
  seat.trail.push(p);
  return { kind: "trailExtend", seatId: seat.id, point: p };
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
  if (state.phase !== "live") {
    return [{ kind: "rejected", seatId, reason: "not_live" }];
  }
  if (state.endsAtMs !== null && nowMs >= state.endsAtMs) {
    effects.push(...endLobby(state));
    return effects;
  }

  const seat = state.seats.get(seatId);
  if (!seat) return [{ kind: "rejected", seatId, reason: "no_seat" }];
  if (fix.accuracyM > 40) {
    return [{ kind: "rejected", seatId, reason: "accuracy" }];
  }
  if (fix.speedMps > 8) {
    return [{ kind: "rejected", seatId, reason: "speed" }];
  }

  effects.push(...ensureRespawnSafe(state, seat));

  const raw: LatLon = { lat: fix.lat, lon: fix.lon };
  const outside = !isInsideArena(state.arena, raw);
  const pos = clampToArena(state.arena, raw);
  if (outside) {
    effects.push({ kind: "boundaryPush", seatId, at: pos });
  }
  seat.position = pos;

  // Plant — Manual drag uses plant:false so proximity never auto-respawns.
  if (seat.mode === "toPlant" || seat.mode === "joining") {
    if (seat.respawnAt === null) {
      seat.respawnAt = pickNearestSafePoint(state, pos, seat.id);
    }
    const d = haversineM(pos.lat, pos.lon, seat.respawnAt.lat, seat.respawnAt.lon);
    if (d <= state.plantRadiusM && fix.plant !== false) {
      const ring = grantStarter(state, seat, seat.respawnAt);
      seat.mode = "safe";
      seat.position = { ...seat.respawnAt };
      seat.respawnAt = null;
      effects.push({ kind: "planted", seatId, ring });
    }
    return effects;
  }

  if (seat.mode === "ghost") {
    if (seat.ghostUntilMs && nowMs < seat.ghostUntilMs) return effects;
    seat.mode = "toPlant";
    return effects;
  }

  // Cuts: proximity to someone else's open freehand trail
  for (const other of state.seats.values()) {
    if (other.id === seat.id) continue;
    if (other.mode !== "trailing") continue;
    if (other.trail.length < 2) continue;
    const dist = distanceToPolylineM(pos, other.trail);
    if (dist > state.cutProximityM) continue;
    // Home contact does not count as a hunt cut
    if (seat.mode === "safe" && pointInOwned(seat, pos)) continue;
    effects.push(...wipeSeat(state, other, seat.id, nowMs));
  }

  const onOwn = pointInOwned(seat, pos);

  if (seat.mode === "safe") {
    if (!onOwn) {
      seat.mode = "trailing";
      seat.trail = [pos];
      effects.push({ kind: "trailOpen", seatId });
      effects.push({ kind: "trailExtend", seatId, point: pos });
    }
    return effects;
  }

  if (seat.mode === "trailing") {
    if (onOwn) {
      const claimed = [...seat.trail, pos];
      // Close ring
      if (
        claimed.length >= 2 &&
        haversineM(
          claimed[0]!.lat,
          claimed[0]!.lon,
          claimed[claimed.length - 1]!.lat,
          claimed[claimed.length - 1]!.lon,
        ) > 1
      ) {
        claimed.push({ ...claimed[0]! });
      }
      let area = ringAreaM2(claimed);
      let bankRing = claimed;
      // Thin out-and-back: corridor ≈ length × path width, inflate for paint
      if (area < 40 && seat.trail.length >= 2) {
        const len = polylineLengthM(seat.trail);
        area = len * state.pathWidthM;
        bankRing = inflateTrailRing(seat.trail, state.pathWidthM / 2);
      }
      // ONE connected polygon: starter + enclosed path (never detached blobs)
      bankTerritory(seat, bankRing, state.pathWidthM);
      stealOverlapping(state, seat, seat.owned[0]!);
      effects.push({
        kind: "banked",
        seatId,
        ring: seat.owned[0]!,
        areaM2: seat.areaM2,
      });
      return effects;
    }

    const ext = appendTrail(state, seat, pos);
    if (ext) effects.push(ext);
  }

  return effects;
}

/** Replace owned with a single merged perimeter (starter ∪ banked loop). */
function bankTerritory(seat: Seat, newRing: LatLon[], pathWidthM: number) {
  seat.owned = [mergeRingsToOne([...seat.owned, newRing])];
  seat.trail = [];
  seat.mode = "safe";
  recomputeArea(seat, pathWidthM);
}

/** Build a thin closed ring around a polyline (stadium / buffer approx). */
function inflateTrailRing(line: LatLon[], halfWidthM: number): LatLon[] {
  if (line.length < 2) return circleRing(line[0] ?? { lat: 0, lon: 0 }, halfWidthM, 10);
  const origin = line[0]!;
  const pts = line.map((p) => toLocalM(origin.lat, origin.lon, p.lat, p.lon));
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidthM;
    const ny = (dx / len) * halfWidthM;
    left.push({ x: pts[i]!.x + nx, y: pts[i]!.y + ny });
    right.push({ x: pts[i]!.x - nx, y: pts[i]!.y - ny });
  }
  const ringLocal = [...left, ...right.reverse()];
  const ring = ringLocal.map((p) => fromLocalM(origin.lat, origin.lon, p.x, p.y));
  ring.push({ ...ring[0]! });
  return ring;
}

/** Tick lobby clock; end if past endsAt. Also refresh contested respawns. */
export function tickLobby(state: LobbyState, nowMs: number): Effect[] {
  const effects: Effect[] = [];
  if (state.phase === "live" && state.endsAtMs !== null && nowMs >= state.endsAtMs) {
    return endLobby(state);
  }
  if (state.phase === "live") {
    for (const seat of state.seats.values()) {
      if (seat.mode === "toPlant") {
        effects.push(...ensureRespawnSafe(state, seat));
      }
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
    owned: seat.owned.map((ring) => ring.map((p) => ({ ...p }))),
    position: seat.position ? { ...seat.position } : null,
    respawnAt: seat.respawnAt ? { ...seat.respawnAt } : null,
  };
}

/** Debug helper: how far a seat is from arena center. */
export function seatArenaDistM(state: LobbyState, seatId: SeatId): number | null {
  const seat = state.seats.get(seatId);
  if (!seat?.position) return null;
  return distanceToArenaCenterM(state.arena, seat.position);
}
