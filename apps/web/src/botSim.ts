import {
  applyFix,
  createLobby,
  joinLobby,
  startLobby,
  tickLobby,
  topScores,
  type LobbyGraph,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

const BOTS = 8;

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
  seats: SimSnapshotSeat[];
  top3: { nickname: string; color: string; areaM2: number }[];
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

function botStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  now: number,
) {
  const graph = state.graph;
  let nodeId = seat.headNode ?? seat.respawnNode ?? 0;
  if (seat.mode === "toPlant" && seat.respawnNode !== null) {
    nodeId = seat.respawnNode;
  } else if (seat.mode === "safe" && rand() < 0.45) {
    const prey = [...state.seats.values()].find(
      (s) => s.id !== seat.id && s.mode === "trailing" && s.headEdge !== null,
    );
    if (prey?.headEdge != null) {
      const e = graph.edges[prey.headEdge]!;
      nodeId = rand() < 0.5 ? e.a : e.b;
    } else {
      const edges = graph.nodeEdges.get(nodeId) ?? [];
      if (edges.length) {
        const e = graph.edges[edges[Math.floor(rand() * edges.length)]!]!;
        nodeId = e.a === nodeId ? e.b : e.a;
      }
    }
  } else {
    const edges = graph.nodeEdges.get(nodeId) ?? [];
    if (edges.length && rand() > 0.08) {
      const e = graph.edges[edges[Math.floor(rand() * edges.length)]!]!;
      nodeId = e.a === nodeId ? e.b : e.a;
    } else {
      nodeId = graph.nodes[Math.floor(rand() * graph.nodes.length)]!.id;
    }
  }
  const n = graph.nodes[nodeId]!;
  applyFix(
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

export class CampusSim {
  state: LobbyState;
  private rand: () => number;
  private t0: number;
  nowMs: number;
  private seed: number;

  constructor(graph: LobbyGraph, seed = 42) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.state = createLobby("DEMO", graph, {
      durationMs: 15 * 60 * 1000,
      maxSeats: BOTS,
    });
    for (let i = 0; i < BOTS; i++) {
      joinLobby(this.state, `Bot${i + 1}`);
    }
    this.t0 = Date.UTC(2026, 9, 24, 18, 0, 0);
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  restart() {
    const graph = this.state.graph;
    this.rand = mulberry32(this.seed + 1);
    this.seed += 1;
    this.state = createLobby("DEMO", graph, {
      durationMs: 15 * 60 * 1000,
      maxSeats: BOTS,
    });
    for (let i = 0; i < BOTS; i++) {
      joinLobby(this.state, `Bot${i + 1}`);
    }
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  /** Advance one simulated second. */
  tickOnce() {
    if (this.state.phase === "ended") return;
    this.nowMs += 1000;
    for (const seat of this.state.seats.values()) {
      botStep(this.state, seat, this.rand, this.nowMs);
    }
    // Occasional forced hunt so cuts show up in a short watch.
    if (Math.floor((this.nowMs - this.t0) / 1000) % 5 === 0) {
      const prey = [...this.state.seats.values()].find(
        (s) => s.mode === "trailing" && (s.trail.length > 0 || s.headEdge !== null),
      );
      const hunter = [...this.state.seats.values()].find(
        (s) => s.mode === "safe" && prey && s.id !== prey.id,
      );
      if (prey && hunter) {
        const edgeId = prey.headEdge ?? prey.trail[prey.trail.length - 1]!;
        const e = this.state.graph.edges[edgeId]!;
        const n = this.state.graph.nodes[e.a]!;
        applyFix(
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
        );
      }
    }
    tickLobby(this.state, this.nowMs);
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
      seats,
      top3,
    };
  }
}
