/**
 * 8-bot mock lobby on the Keller Hall fixture graph.
 * Synthetic GPS walks — plant, trail, bank, cut, wipe, respawn.
 * Exit 0 only if all invariants hold.
 */
import {
  applyFix,
  buildKellerFixtureGraph,
  createLobby,
  joinLobby,
  seatPublicView,
  startLobby,
  tickLobby,
  topScores,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

const SEED = 42;
const BOTS = 8;
const TICKS = 900; // ~15 min at 1s if duration matched; we use shorter duration for CI
const DURATION_MS = 60_000; // 1 min compressed sim window for CI speed

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SIM_FAIL: ${msg}`);
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
  } else if (seat.mode === "safe" && rand() < 0.55) {
    // Hunt: step toward another player's open trail tip.
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
    if (edges.length && rand() > 0.1) {
      const e = graph.edges[edges[Math.floor(rand() * edges.length)]!]!;
      nodeId = e.a === nodeId ? e.b : e.a;
    } else {
      nodeId = graph.nodes[Math.floor(rand() * graph.nodes.length)]!.id;
    }
  }
  const n = graph.nodes[nodeId]!;
  const fix = {
    lat: n.lat + (rand() - 0.5) * 0.00002,
    lon: n.lon + (rand() - 0.5) * 0.00002,
    accuracyM: 5 + rand() * 4,
    speedMps: 1 + rand() * 3,
    clientTsMs: now,
    mock: true,
  };
  applyFix(state, seat.id, fix, now);
}

function checkInvariants(state: LobbyState, label: string) {
  assert(state.seats.size <= 8, `${label}: more than 8 seats`);
  for (const seat of state.seats.values()) {
    if (seat.mode === "toPlant" || seat.mode === "ghost") {
      assert(
        seat.ownedEdges.size === 0,
        `${label}: ${seat.nickname} ghost/toPlant still owns land`,
      );
      assert(
        seat.trail.length === 0,
        `${label}: ${seat.nickname} should not trail while ${seat.mode}`,
      );
    }
    if (seat.mode === "toPlant") {
      assert(
        seat.respawnNode !== null,
        `${label}: ${seat.nickname} toPlant without marker`,
      );
    }
    for (const e of seat.ownedEdges) {
      assert(
        state.edgeOwner.get(e) === seat.id,
        `${label}: edge owner mismatch for ${seat.nickname}`,
      );
    }
  }
  // edgeOwner only points at existing seats
  for (const [e, sid] of state.edgeOwner) {
    assert(state.seats.has(sid), `${label}: dangling edge owner on ${e}`);
  }
}

function main() {
  const rand = mulberry32(SEED);
  const graph = buildKellerFixtureGraph(90);
  const lobby = createLobby("SIM8", graph, {
    durationMs: DURATION_MS,
    maxSeats: BOTS,
  });

  for (let i = 0; i < BOTS; i++) {
    joinLobby(lobby, `Bot${i + 1}`);
  }
  assert(lobby.seats.size === 8, "expected 8 bots");

  const t0 = Date.UTC(2026, 9, 24, 18, 0, 0);
  startLobby(lobby, t0);
  checkInvariants(lobby, "after-start");

  let cuts = 0;
  let plants = 0;
  let banks = 0;

  for (let tick = 0; tick < TICKS; tick++) {
    const simNow = t0 + Math.floor((tick / TICKS) * (DURATION_MS + 2000));
    for (const seat of lobby.seats.values()) {
      const beforeMode = seat.mode;
      const beforeTrail = seat.trail.length;
      const beforeOwned = seat.ownedEdges.size;
      botStep(lobby, seat, rand, simNow);
      if (beforeMode === "toPlant" && seat.mode === "safe") plants++;
      if (seat.mode === "safe" && beforeTrail > 0 && seat.trail.length === 0) {
        banks++;
      }
      if (beforeOwned > 0 && seat.ownedEdges.size === 0 && seat.mode === "toPlant") {
        cuts++;
      }
    }

    // Guaranteed hunt attempts: teleport a safe bot onto a trailing bot's trail tip.
    if (tick % 5 === 0) {
      const prey = [...lobby.seats.values()].find(
        (s) => s.mode === "trailing" && (s.trail.length > 0 || s.headEdge !== null),
      );
      const hunter = [...lobby.seats.values()].find(
        (s) => s.mode === "safe" && prey && s.id !== prey.id,
      );
      if (prey && hunter) {
        const edgeId = prey.headEdge ?? prey.trail[prey.trail.length - 1]!;
        const e = lobby.graph.edges[edgeId]!;
        const n = lobby.graph.nodes[e.a]!;
        const beforeOwned = prey.ownedEdges.size;
        applyFix(
          lobby,
          hunter.id,
          {
            lat: n.lat,
            lon: n.lon,
            accuracyM: 5,
            speedMps: 2,
            clientTsMs: simNow,
            mock: true,
          },
          simNow,
        );
        if (beforeOwned > 0 && prey.ownedEdges.size === 0 && prey.mode === "toPlant") {
          cuts++;
        }
      }
    }

    tickLobby(lobby, simNow);
    if (tick % 50 === 0) checkInvariants(lobby, `tick-${tick}`);
    if (lobby.phase === "ended") break;
  }

  // Force end
  tickLobby(lobby, t0 + DURATION_MS + 1000);
  assert(lobby.phase === "ended", "lobby should have ended");
  checkInvariants(lobby, "ended");

  const top = topScores(lobby, 3);
  assert(top.length === 3, "top 3 required");
  assert(top[0]!.areaM2 >= top[1]!.areaM2, "top sorted");
  assert(plants >= 8, "every bot should plant at least once");
  assert(cuts >= 1, "expected at least one wipe from trail cuts");
  assert(banks >= 1, "expected at least one bank");

  // Late join forbidden after end
  let lateJoinBlocked = false;
  try {
    joinLobby(lobby, "Late");
  } catch {
    lateJoinBlocked = true;
  }
  assert(lateJoinBlocked, "late join must fail after ended");

  console.log(
    JSON.stringify(
      {
        ok: true,
        graph: graph.id,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        plants,
        banks,
        cuts,
        top3: top.map((s) => ({
          nickname: s.nickname,
          areaM2: Math.round(s.areaM2),
        })),
        seats: [...lobby.seats.values()].map(seatPublicView),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
