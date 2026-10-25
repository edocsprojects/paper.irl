import { haversineM } from "./geo.js";
import type {
  EdgeId,
  Effect,
  FaceId,
  Fix,
  LobbyGraph,
  LobbyState,
  NodeId,
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
  graph: LobbyGraph,
  opts?: { durationMs?: number; maxSeats?: number },
): LobbyState {
  return {
    code,
    phase: "open",
    durationMs: opts?.durationMs ?? 15 * 60 * 1000,
    startedAtMs: null,
    endsAtMs: null,
    graph,
    edgeOwner: new Map(),
    faceOwner: new Map(),
    seats: new Map(),
    nextSeatId: 1,
    cutOverlapM: 15,
    plantDwellMs: 2000,
    plantRadiusM: 20,
    pathWidthM: graph.pathWidthM,
    maxSeats: opts?.maxSeats ?? 8,
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
    ownedEdges: new Set(),
    ownedFaces: new Set(),
    trail: [],
    headEdge: null,
    headNode: null,
    respawnNode: null,
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
    const node = pickNearestSafeNode(state, null, randomSeed(seat.id));
    seat.respawnNode = node;
    seat.mode = "toPlant";
    effects.push({ kind: "respawnAssigned", seatId: seat.id, nodeId: node });
  }
  return effects;
}

export function endLobby(state: LobbyState): Effect[] {
  state.phase = "ended";
  for (const seat of state.seats.values()) {
    seat.trail = [];
    seat.headEdge = null;
    if (seat.mode === "trailing") seat.mode = "safe";
  }
  return [{ kind: "phase", phase: "ended" }];
}

export function topScores(state: LobbyState, n = 3): Seat[] {
  return [...state.seats.values()]
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, n);
}

function randomSeed(n: number) {
  return (n * 1103515245 + 12345) >>> 0;
}

function recomputeArea(state: LobbyState, seat: Seat) {
  let area = 0;
  for (const e of seat.ownedEdges) {
    area += state.graph.edges[e]!.areaM2;
  }
  for (const f of seat.ownedFaces) {
    area += state.graph.faces[f]!.areaM2;
  }
  seat.areaM2 = area;
}

function edgeOther(edge: { a: NodeId; b: NodeId }, node: NodeId): NodeId {
  return edge.a === node ? edge.b : edge.a;
}

function isSafeNode(state: LobbyState, nodeId: NodeId, exceptSeat: SeatId | null): boolean {
  for (const eId of state.graph.nodeEdges.get(nodeId) ?? []) {
    const owner = state.edgeOwner.get(eId);
    if (owner !== undefined && owner !== exceptSeat) return false;
    for (const s of state.seats.values()) {
      if (exceptSeat !== null && s.id === exceptSeat) continue;
      if (s.mode === "trailing" && (s.trail.includes(eId) || s.headEdge === eId)) {
        return false;
      }
    }
  }
  return true;
}

export function pickNearestSafeNode(
  state: LobbyState,
  fromNode: NodeId | null,
  seed = 1,
): NodeId {
  const nodes = state.graph.nodes;
  const origin =
    fromNode !== null
      ? nodes[fromNode]!
      : nodes[seed % nodes.length]!;
  const ranked = [...nodes].sort((a, b) => {
    const da = haversineM(origin.lat, origin.lon, a.lat, a.lon);
    const db = haversineM(origin.lat, origin.lon, b.lat, b.lon);
    return da - db;
  });
  for (const n of ranked) {
    if (isSafeNode(state, n.id, null)) return n.id;
  }
  return ranked[0]!.id;
}

function snapFix(
  graph: LobbyGraph,
  fix: Fix,
): { edgeId: EdgeId; nodeId: NodeId; distM: number } | null {
  // Nearest node, then best incident edge (scales to OSM-sized graphs).
  let bestNode: { nodeId: NodeId; distM: number } | null = null;
  for (const n of graph.nodes) {
    const dist = haversineM(fix.lat, fix.lon, n.lat, n.lon);
    if (!bestNode || dist < bestNode.distM) {
      bestNode = { nodeId: n.id, distM: dist };
    }
  }
  if (!bestNode || bestNode.distM > 45) return null;
  const incident = graph.nodeEdges.get(bestNode.nodeId) ?? [];
  if (!incident.length) return null;
  let bestEdge = incident[0]!;
  let bestEdgeDist = Infinity;
  for (const eId of incident) {
    const e = graph.edges[eId]!;
    const otherId = e.a === bestNode.nodeId ? e.b : e.a;
    const other = graph.nodes[otherId]!;
    const d = haversineM(fix.lat, fix.lon, other.lat, other.lon);
    if (d < bestEdgeDist) {
      bestEdgeDist = d;
      bestEdge = eId;
    }
  }
  return { edgeId: bestEdge, nodeId: bestNode.nodeId, distM: bestNode.distM };
}

function grantStarter(state: LobbyState, seat: Seat, atNode: NodeId): EdgeId[] {
  const granted: EdgeId[] = [];
  const incident = state.graph.nodeEdges.get(atNode) ?? [];
  for (const eId of incident) {
    if (state.edgeOwner.has(eId)) continue;
    state.edgeOwner.set(eId, seat.id);
    seat.ownedEdges.add(eId);
    granted.push(eId);
  }
  // One more hop of neutrals if tiny.
  if (granted.length < 2) {
    for (const eId of [...granted]) {
      const e = state.graph.edges[eId]!;
      for (const n of [e.a, e.b]) {
        for (const e2 of state.graph.nodeEdges.get(n) ?? []) {
          if (state.edgeOwner.has(e2)) continue;
          state.edgeOwner.set(e2, seat.id);
          seat.ownedEdges.add(e2);
          granted.push(e2);
        }
      }
    }
  }
  recomputeArea(state, seat);
  maybeEncloseFaces(state, seat);
  return granted;
}

function maybeEncloseFaces(state: LobbyState, seat: Seat) {
  for (const face of state.graph.faces) {
    if (face.edgeIds.every((e) => seat.ownedEdges.has(e))) {
      const prev = state.faceOwner.get(face.id);
      if (prev !== undefined && prev !== seat.id) {
        const other = state.seats.get(prev);
        other?.ownedFaces.delete(face.id);
        if (other) recomputeArea(state, other);
      }
      state.faceOwner.set(face.id, seat.id);
      seat.ownedFaces.add(face.id);
    }
  }
  recomputeArea(state, seat);
}

function wipeSeat(state: LobbyState, victim: Seat, byId: SeatId, nowMs: number): Effect[] {
  const effects: Effect[] = [{ kind: "cut", victimId: victim.id, byId }];
  for (const e of victim.ownedEdges) {
    state.edgeOwner.delete(e);
  }
  for (const f of victim.ownedFaces) {
    state.faceOwner.delete(f);
  }
  victim.ownedEdges.clear();
  victim.ownedFaces.clear();
  victim.trail = [];
  victim.headEdge = null;
  victim.headNode = null;
  victim.areaM2 = 0;
  victim.mode = "ghost";
  victim.ghostUntilMs = nowMs + 3000;
  const node = pickNearestSafeNode(state, victim.headNode, victim.id * 17);
  victim.respawnNode = node;
  victim.mode = "toPlant";
  effects.push({ kind: "respawnAssigned", seatId: victim.id, nodeId: node });
  return effects;
}

function ensureRespawnSafe(state: LobbyState, seat: Seat): Effect[] {
  if (seat.respawnNode === null) return [];
  if (isSafeNode(state, seat.respawnNode, seat.id)) return [];
  const node = pickNearestSafeNode(state, seat.respawnNode, seat.id * 31);
  seat.respawnNode = node;
  return [{ kind: "respawnMoved", seatId: seat.id, nodeId: node }];
}

/**
 * Apply one GPS fix for a seat. Server authority entry point.
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

  const snap = snapFix(state.graph, fix);
  if (!snap) {
    return effects;
  }

  // Plant
  if (seat.mode === "toPlant" || seat.mode === "joining") {
    const marker = seat.respawnNode;
    if (marker === null) {
      seat.respawnNode = pickNearestSafeNode(state, snap.nodeId, seat.id);
    }
    const target = state.graph.nodes[seat.respawnNode!]!;
    const d = haversineM(fix.lat, fix.lon, target.lat, target.lon);
    if (d <= state.plantRadiusM) {
      const granted = grantStarter(state, seat, seat.respawnNode!);
      seat.mode = "safe";
      seat.headNode = seat.respawnNode;
      seat.headEdge = snap.edgeId;
      seat.respawnNode = null;
      effects.push({ kind: "planted", seatId, edges: granted });
    }
    return effects;
  }

  if (seat.mode === "ghost") {
    if (seat.ghostUntilMs && nowMs < seat.ghostUntilMs) return effects;
    seat.mode = "toPlant";
    return effects;
  }

  // Cuts: if we step on someone else's open trail edge
  for (const other of state.seats.values()) {
    if (other.id === seat.id) continue;
    if (other.mode !== "trailing") continue;
    const onTrail =
      other.trail.includes(snap.edgeId) || other.headEdge === snap.edgeId;
    if (!onTrail) continue;
    // Home contact does not cut: cutter must not be only on own land without trailing intent.
    // Plan: cut from home does not count as hunt — skip if seat is safe and edge is owned by seat.
    if (seat.mode === "safe" && seat.ownedEdges.has(snap.edgeId)) continue;
    effects.push(...wipeSeat(state, other, seat.id, nowMs));
  }

  const onOwn = seat.ownedEdges.has(snap.edgeId);

  if (seat.mode === "safe") {
    if (!onOwn) {
      seat.mode = "trailing";
      seat.trail = [snap.edgeId];
      seat.headEdge = snap.edgeId;
      seat.headNode = snap.nodeId;
      effects.push({ kind: "trailOpen", seatId });
      effects.push({ kind: "trailExtend", seatId, edgeId: snap.edgeId });
    } else {
      seat.headEdge = snap.edgeId;
      seat.headNode = snap.nodeId;
    }
    return effects;
  }

  if (seat.mode === "trailing") {
    if (onOwn) {
      // Bank
      const claimed = [...seat.trail];
      for (const eId of claimed) {
        const prev = state.edgeOwner.get(eId);
        if (prev !== undefined && prev !== seat.id) {
          const other = state.seats.get(prev);
          other?.ownedEdges.delete(eId);
          if (other) recomputeArea(state, other);
        }
        state.edgeOwner.set(eId, seat.id);
        seat.ownedEdges.add(eId);
      }
      seat.trail = [];
      seat.headEdge = snap.edgeId;
      seat.headNode = snap.nodeId;
      seat.mode = "safe";
      maybeEncloseFaces(state, seat);
      recomputeArea(state, seat);
      effects.push({
        kind: "banked",
        seatId,
        edges: claimed,
        faces: [...seat.ownedFaces],
      });
      return effects;
    }

    if (!seat.trail.includes(snap.edgeId)) {
      seat.trail.push(snap.edgeId);
      effects.push({ kind: "trailExtend", seatId, edgeId: snap.edgeId });
    }
    seat.headEdge = snap.edgeId;
    seat.headNode = snap.nodeId;
  }

  return effects;
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
    trail: [...seat.trail],
    headEdge: seat.headEdge,
    headNode: seat.headNode,
    respawnNode: seat.respawnNode,
    ownedEdgeCount: seat.ownedEdges.size,
    ownedFaceCount: seat.ownedFaces.size,
  };
}
