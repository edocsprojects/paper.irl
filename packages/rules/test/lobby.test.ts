import { describe, expect, it } from "vitest";
import {
  applyFix,
  buildKellerFixtureGraph,
  createLobby,
  joinLobby,
  startLobby,
  tickLobby,
  topScores,
} from "../src/index.js";

const graph = buildKellerFixtureGraph(100);

function fixAtNode(
  graphId: typeof graph,
  nodeId: number,
  t: number,
) {
  const n = graphId.nodes[nodeId]!;
  return {
    lat: n.lat,
    lon: n.lon,
    accuracyM: 8,
    speedMps: 2,
    clientTsMs: t,
  };
}

describe("keller fixture", () => {
  it("builds a connected campus-sized graph", () => {
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(20);
    expect(graph.faces.length).toBeGreaterThan(5);
    expect(graph.radiusM).toBe(500);
  });
});

describe("lobby lifecycle", () => {
  it("creates, joins with nicknames, rejects 9th seat", () => {
    const lobby = createLobby("KELL", graph);
    for (let i = 0; i < 8; i++) {
      joinLobby(lobby, `P${i}`);
    }
    expect(lobby.seats.size).toBe(8);
    expect(() => joinLobby(lobby, "X")).toThrow(/lobby_full/);

    const lobby2 = createLobby("K2", graph);
    joinLobby(lobby2, "Alex");
    const { seat } = joinLobby(lobby2, "Alex");
    expect(seat.nickname).toBe("Alex2");
  });

  it("requires host start before claims", () => {
    const lobby = createLobby("KELL", graph);
    const { seat } = joinLobby(lobby, "Sam");
    const n = graph.nodes[0]!;
    const effects = applyFix(
      lobby,
      seat.id,
      {
        lat: n.lat,
        lon: n.lon,
        accuracyM: 5,
        speedMps: 1,
        clientTsMs: 1,
      },
      1000,
    );
    expect(effects.some((e) => e.kind === "rejected")).toBe(true);
  });
});

describe("plant trail bank cut wipe", () => {
  it("plants only near respawn marker then can trail and bank", () => {
    const lobby = createLobby("KELL", graph, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "A");
    const t0 = 1_000_000;
    startLobby(lobby, t0);
    expect(seat.mode).toBe("toPlant");
    expect(seat.respawnNode).not.toBeNull();

    const far = graph.nodes.find((n) => n.id !== seat.respawnNode)!;
    applyFix(lobby, seat.id, fixAtNode(graph, far.id, t0 + 100), t0 + 100);
    expect(seat.mode).toBe("toPlant");
    expect(seat.ownedEdges.size).toBe(0);

    applyFix(
      lobby,
      seat.id,
      fixAtNode(graph, seat.respawnNode!, t0 + 200),
      t0 + 200,
    );
    expect(seat.mode).toBe("safe");
    expect(seat.ownedEdges.size).toBeGreaterThan(0);
    expect(seat.areaM2).toBeGreaterThan(0);
  });

  it("wipe sends land to neutral and requires respawn before play", () => {
    const lobby = createLobby("KELL", graph, { durationMs: 120_000 });
    const a = joinLobby(lobby, "A").seat;
    const b = joinLobby(lobby, "B").seat;
    const t0 = 2_000_000;
    startLobby(lobby, t0);

    // Plant both at their markers
    applyFix(lobby, a.id, fixAtNode(graph, a.respawnNode!, t0 + 1), t0 + 1);
    applyFix(lobby, b.id, fixAtNode(graph, b.respawnNode!, t0 + 2), t0 + 2);
    expect(a.mode).toBe("safe");
    expect(b.mode).toBe("safe");

    // Force A onto a neutral edge to open trail
    const foreign = graph.edges.find((e) => !a.ownedEdges.has(e.id))!;
    const node = graph.nodes[foreign.a]!;
    applyFix(
      lobby,
      a.id,
      {
        lat: node.lat,
        lon: node.lon,
        accuracyM: 5,
        speedMps: 2,
        clientTsMs: t0 + 10,
      },
      t0 + 10,
    );
    expect(a.mode).toBe("trailing");
    expect(a.trail.length).toBeGreaterThan(0);
    const trailEdge = a.trail[0]!;

    // B steps on A's trail edge
    const te = graph.edges[trailEdge]!;
    const tn = graph.nodes[te.a]!;
    const beforeOwned = a.ownedEdges.size;
    expect(beforeOwned).toBeGreaterThan(0);
    applyFix(
      lobby,
      b.id,
      {
        lat: tn.lat,
        lon: tn.lon,
        accuracyM: 5,
        speedMps: 2,
        clientTsMs: t0 + 20,
      },
      t0 + 20,
    );

    expect(a.ownedEdges.size).toBe(0);
    expect(a.areaM2).toBe(0);
    expect(a.mode).toBe("toPlant");
    expect(a.respawnNode).not.toBeNull();
    // Land neutral: no owner on previous edges
    for (const e of a.ownedEdges) {
      expect(lobby.edgeOwner.has(e)).toBe(false);
    }

    // Cannot claim until plant again — trailing blocked
    const mid = graph.edges[0]!;
    const mn = graph.nodes[mid.a]!;
    applyFix(
      lobby,
      a.id,
      {
        lat: mn.lat,
        lon: mn.lon,
        accuracyM: 5,
        speedMps: 2,
        clientTsMs: t0 + 30,
      },
      t0 + 30,
    );
    expect(a.mode).toBe("toPlant");
    expect(a.ownedEdges.size).toBe(0);
  });

  it("ends lobby and ranks top 3 by area", () => {
    const lobby = createLobby("KELL", graph, { durationMs: 5_000 });
    const seats = ["A", "B", "C", "D"].map((n) => joinLobby(lobby, n).seat);
    const t0 = 3_000_000;
    startLobby(lobby, t0);
    for (const s of seats) {
      applyFix(lobby, s.id, fixAtNode(graph, s.respawnNode!, t0 + 1), t0 + 1);
    }
    // Give D more land by banking a trail
    const d = seats[3]!;
    const foreign = graph.edges.find((e) => !d.ownedEdges.has(e.id))!;
    applyFix(
      lobby,
      d.id,
      fixAtNode(graph, foreign.a, t0 + 2),
      t0 + 2,
    );
    // return to owned
    const home = [...d.ownedEdges][0]!;
    const hn = graph.edges[home]!.a;
    applyFix(lobby, d.id, fixAtNode(graph, hn, t0 + 3), t0 + 3);

    const effects = tickLobby(lobby, t0 + 6_000);
    expect(lobby.phase).toBe("ended");
    expect(effects.some((e) => e.kind === "phase")).toBe(true);
    const top = topScores(lobby, 3);
    expect(top).toHaveLength(3);
    expect(top[0]!.areaM2).toBeGreaterThanOrEqual(top[1]!.areaM2);
  });
});
