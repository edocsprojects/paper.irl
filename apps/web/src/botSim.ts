import {
  applyFix,
  createLobby,
  joinLobby,
  pickNearestSafeNode,
  startLobby,
  tickLobby,
  topScores,
  type Effect,
  type LobbyGraph,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

export const YOU_ID = 1;
const BOTS = 8;
/** Demo grace after plant so P1 isn't wiped the same second they spawn. */
const YOU_PROTECT_MS = 25_000;

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimSnapshotSeat {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  lat: number;
  lon: number;
  trail: number[];
  ownedEdges: number[];
  respawnNode: number | null;
  headNode: number | null;
}

export interface SimSnapshot {
  phase: string;
  startedAtMs: number;
  endsAtMs: number;
  nowMs: number;
  remainingMs: number;
  youNeedSpawn: boolean;
  seats: SimSnapshotSeat[];
  top3: { id: number; nickname: string; color: string; areaM2: number }[];
  you: SimSnapshotSeat | null;
}

function seatLatLon(state: LobbyState, seat: Seat): { lat: number; lon: number } {
  const g = state.graph;
  const nodeId =
    seat.headNode ??
    seat.respawnNode ??
    g.nodes[Math.floor(g.nodes.length / 2)]!.id;
  const n = g.nodes[nodeId]!;
  return { lat: n.lat, lon: n.lon };
}

function youTrailEdges(state: LobbyState): Set<number> {
  const you = state.seats.get(YOU_ID);
  if (!you || you.mode !== "trailing") return new Set();
  const s = new Set(you.trail);
  if (you.headEdge != null) s.add(you.headEdge);
  return s;
}

function stepToNeighbor(
  graph: LobbyGraph,
  nodeId: number,
  rand: () => number,
  avoidEdges?: Set<number>,
): number {
  const edges = graph.nodeEdges.get(nodeId) ?? [];
  const choices = edges.filter((id) => !avoidEdges?.has(id));
  const pool = choices.length ? choices : edges;
  if (!pool.length) return nodeId;
  const e = graph.edges[pool[Math.floor(rand() * pool.length)]!]!;
  return e.a === nodeId ? e.b : e.a;
}

function botStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  now: number,
  opts: { protectYou: boolean },
): Effect[] {
  const graph = state.graph;
  let nodeId = seat.headNode ?? seat.respawnNode ?? 0;
  const avoid = opts.protectYou ? youTrailEdges(state) : undefined;

  if (seat.mode === "toPlant" && seat.respawnNode !== null) {
    nodeId = seat.respawnNode;
  } else if (seat.id === YOU_ID) {
    const owned = [...seat.ownedEdges];
    // During protect (and generally when safe), stay on owned corridors first.
    if (opts.protectYou && owned.length && seat.mode === "safe") {
      const e = graph.edges[owned[Math.floor(rand() * owned.length)]!]!;
      nodeId = rand() < 0.5 ? e.a : e.b;
    } else if (seat.mode === "trailing" && owned.length) {
      const home = graph.edges[owned[Math.floor(rand() * owned.length)]!]!;
      nodeId = rand() < 0.5 ? home.a : home.b;
    } else if (seat.mode === "safe" && owned.length && rand() < 0.7) {
      const e = graph.edges[owned[Math.floor(rand() * owned.length)]!]!;
      nodeId = rand() < 0.5 ? e.a : e.b;
    } else {
      nodeId = stepToNeighbor(graph, nodeId, rand);
    }
  } else if (seat.mode === "safe" && rand() < 0.4) {
    // Hunt other bots' trails — never Player 1 while protected.
    const prey = [...state.seats.values()].find(
      (s) =>
        s.id !== seat.id &&
        !(opts.protectYou && s.id === YOU_ID) &&
        s.mode === "trailing" &&
        s.headEdge !== null,
    );
    if (prey?.headEdge != null) {
      const e = graph.edges[prey.headEdge]!;
      nodeId = rand() < 0.5 ? e.a : e.b;
    } else {
      nodeId = stepToNeighbor(graph, nodeId, rand, avoid);
    }
  } else {
    const edges = graph.nodeEdges.get(nodeId) ?? [];
    if (edges.length && rand() > 0.12) {
      nodeId = stepToNeighbor(graph, nodeId, rand, avoid);
    } else {
      // No random teleport onto the map — that caused instant P1 wipes.
      nodeId = stepToNeighbor(graph, nodeId, rand, avoid);
    }
  }

  const n = graph.nodes[nodeId]!;
  return applyFix(
    state,
    seat.id,
    {
      lat: n.lat + (rand() - 0.5) * 0.000015,
      lon: n.lon + (rand() - 0.5) * 0.000015,
      accuracyM: 5 + rand() * 4,
      speedMps: 1 + rand() * 2.5,
      clientTsMs: now,
      mock: true,
    },
    now,
  );
}

function youAwaitingSpawn(state: LobbyState): boolean {
  const you = state.seats.get(YOU_ID);
  if (!you) return false;
  return you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost";
}

export class CampusSim {
  state: LobbyState;
  private rand: () => number;
  private t0: number;
  nowMs: number;
  private seed: number;
  private youProtectUntilMs = 0;

  constructor(graph: LobbyGraph, seed = 42) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.state = createLobby("DEMO", graph, {
      durationMs: 15 * 60 * 1000,
      maxSeats: BOTS,
    });
    joinLobby(this.state, "You");
    for (let i = 2; i <= BOTS; i++) {
      joinLobby(this.state, `Bot${i}`);
    }
    this.t0 = Date.UTC(2026, 9, 24, 18, 0, 0);
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  restart() {
    const graph = this.state.graph;
    this.rand = mulberry32(this.seed + 1);
    this.seed += 1;
    this.youProtectUntilMs = 0;
    this.state = createLobby("DEMO", graph, {
      durationMs: 15 * 60 * 1000,
      maxSeats: BOTS,
    });
    joinLobby(this.state, "You");
    for (let i = 2; i <= BOTS; i++) {
      joinLobby(this.state, `Bot${i}`);
    }
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  /** Player 1 taps Spawn → plant at a fresh safe marker. */
  spawnYou(): Effect[] {
    const you = this.state.seats.get(YOU_ID);
    if (!you || this.state.phase !== "live") return [];
    if (you.mode === "ghost") {
      you.mode = "toPlant";
      you.ghostUntilMs = null;
    }
    if (you.mode !== "toPlant" && you.mode !== "joining") return [];

    // Re-pick nearest safe node at click time (bots may have claimed the old marker).
    const from = you.respawnNode ?? you.headNode;
    you.respawnNode = pickNearestSafeNode(this.state, from, you.id * 17);
    const n = this.state.graph.nodes[you.respawnNode]!;
    const effects = applyFix(
      this.state,
      YOU_ID,
      {
        lat: n.lat,
        lon: n.lon,
        accuracyM: 5,
        speedMps: 1,
        clientTsMs: this.nowMs,
        mock: true,
      },
      this.nowMs,
    );
    if (effects.some((e) => e.kind === "planted" && e.seatId === YOU_ID)) {
      this.youProtectUntilMs = this.nowMs + YOU_PROTECT_MS;
    }
    return effects;
  }

  /** Advance one simulated second. Returns game effects for snackbars. */
  tickOnce(): Effect[] {
    if (this.state.phase === "ended") return [];
    this.nowMs += 1000;
    const effects: Effect[] = [];
    const pauseYou = youAwaitingSpawn(this.state);
    const protectYou = this.nowMs < this.youProtectUntilMs;

    // Other bots first, then You — avoids same-tick open-trail → cut.
    const others = [...this.state.seats.values()].filter((s) => s.id !== YOU_ID);
    const you = this.state.seats.get(YOU_ID);

    for (const seat of others) {
      effects.push(
        ...botStep(this.state, seat, this.rand, this.nowMs, { protectYou }),
      );
    }

    if (you && !pauseYou) {
      effects.push(
        ...botStep(this.state, you, this.rand, this.nowMs, { protectYou }),
      );
    }

    // Forced hunts among bots only (never P1).
    if (Math.floor((this.nowMs - this.t0) / 1000) % 7 === 0) {
      const prey = [...this.state.seats.values()].find(
        (s) =>
          s.id !== YOU_ID &&
          s.mode === "trailing" &&
          (s.trail.length > 0 || s.headEdge !== null),
      );
      const hunter = [...this.state.seats.values()].find(
        (s) =>
          s.id !== YOU_ID &&
          s.mode === "safe" &&
          prey &&
          s.id !== prey.id,
      );
      if (prey && hunter) {
        const edgeId = prey.headEdge ?? prey.trail[prey.trail.length - 1]!;
        const e = this.state.graph.edges[edgeId]!;
        const n = this.state.graph.nodes[e.a]!;
        effects.push(
          ...applyFix(
            this.state,
            hunter.id,
            {
              lat: n.lat,
              lon: n.lon,
              accuracyM: 5,
              speedMps: 2,
              clientTsMs: this.nowMs,
              mock: true,
            },
            this.nowMs,
          ),
        );
      }
    }

    effects.push(...tickLobby(this.state, this.nowMs));

    // If a cut still landed on You during protect, restore the wipe (demo guard).
    // Prefer prevention above; this is a backstop so the overlay doesn't flash.
    if (protectYou && you) {
      const cut = effects.find((e) => e.kind === "cut" && e.victimId === YOU_ID);
      if (cut && cut.kind === "cut" && you.mode === "toPlant") {
        // Soft recovery: stay planted at marker without replaying full bank history.
        const nodeId = you.respawnNode ?? pickNearestSafeNode(this.state, null, YOU_ID);
        you.respawnNode = nodeId;
        const n = this.state.graph.nodes[nodeId]!;
        applyFix(
          this.state,
          YOU_ID,
          {
            lat: n.lat,
            lon: n.lon,
            accuracyM: 5,
            speedMps: 1,
            clientTsMs: this.nowMs,
            mock: true,
          },
          this.nowMs,
        );
        return effects.filter((e) => !(e.kind === "cut" && e.victimId === YOU_ID));
      }
    }
    return effects;
  }

  snapshot(): SimSnapshot {
    const ends = this.state.endsAtMs ?? this.nowMs;
    const seats: SimSnapshotSeat[] = [...this.state.seats.values()].map((seat) => {
      const { lat, lon } = seatLatLon(this.state, seat);
      return {
        id: seat.id,
        nickname: seat.nickname,
        mode: seat.mode,
        color: seat.color,
        areaM2: seat.areaM2,
        lat,
        lon,
        trail: [...seat.trail],
        ownedEdges: [...seat.ownedEdges],
        respawnNode: seat.respawnNode,
        headNode: seat.headNode,
      };
    });
    const top3 = topScores(this.state, 3).map((s) => ({
      id: s.id,
      nickname: s.nickname,
      color: s.color,
      areaM2: s.areaM2,
    }));
    return {
      phase: this.state.phase,
      startedAtMs: this.state.startedAtMs ?? this.t0,
      endsAtMs: ends,
      nowMs: this.nowMs,
      remainingMs: Math.max(0, ends - this.nowMs),
      youNeedSpawn: youAwaitingSpawn(this.state) && this.state.phase === "live",
      seats,
      top3,
      you: seats.find((s) => s.id === YOU_ID) ?? null,
    };
  }
}
