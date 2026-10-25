import { describe, expect, it } from "vitest";
import {
  applyFix,
  buildKellerArena,
  buildTrailPaint,
  createLobby,
  fromLocalM,
  haversineM,
  isInsideArena,
  joinLobby,
  markRematchReady,
  pointInTerritory,
  startLobby,
  startRematch,
  tickLobby,
  topScores,
  type LatLon,
  type LobbyState,
  type Seat,
} from "../src/index.js";

const arena = buildKellerArena();
const C = { lat: arena.centerLat, lon: arena.centerLon };
const at = (x: number, y: number, o: LatLon = C) => fromLocalM(o.lat, o.lon, x, y);

function fixAt(
  p: LatLon,
  t: number,
  opts?: { speedMps?: number; accuracyM?: number; plant?: boolean },
) {
  return {
    lat: p.lat,
    lon: p.lon,
    accuracyM: opts?.accuracyM ?? 3,
    speedMps: opts?.speedMps ?? 2,
    clientTsMs: t,
    plant: opts?.plant,
  };
}

/** Walk in ~1 m steps along local-metre waypoints relative to `o`. */
function walk(
  lobby: LobbyState,
  seat: Seat,
  pts: [number, number][],
  clock: { t: number },
  o: LatLon = C,
) {
  let cur = seat.position!;
  for (const [x, y] of pts) {
    const target = at(x, y, o);
    const d = haversineM(cur.lat, cur.lon, target.lat, target.lon);
    const n = Math.max(1, Math.ceil(d / 1));
    const from = cur;
    for (let i = 1; i <= n; i++) {
      const p = {
        lat: from.lat + ((target.lat - from.lat) * i) / n,
        lon: from.lon + ((target.lon - from.lon) * i) / n,
      };
      clock.t += 400;
      applyFix(lobby, seat.id, fixAt(p, clock.t), clock.t);
      if (seat.mode !== "safe" && seat.mode !== "trailing") return;
    }
    cur = target;
  }
}

/** Lobby with seats pre-positioned (GPS before start) and planted where they stand. */
function liveLobby(spots: [number, number][], t0 = 1_000_000) {
  const lobby = createLobby("TEST", arena, { durationMs: 10 * 60_000 });
  const seats = spots.map((_, i) => joinLobby(lobby, `P${i + 1}`).seat);
  spots.forEach(([x, y], i) => applyFix(lobby, seats[i]!.id, fixAt(at(x, y), t0), t0));
  startLobby(lobby, t0);
  const clock = { t: t0 + 1 };
  spots.forEach(([x, y], i) => {
    applyFix(lobby, seats[i]!.id, fixAt(at(x, y), clock.t), clock.t);
  });
  return { lobby, seats, clock };
}

describe("keller freeplay arena", () => {
  it("is a 500 m Keller circle", () => {
    expect(arena.radiusM).toBe(500);
    expect(arena.centerLat).toBeCloseTo(44.97452, 4);
    expect(arena.id).toContain("freeplay");
  });
});

describe("lobby lifecycle", () => {
  it("creates, joins with nicknames, rejects 9th seat", () => {
    const lobby = createLobby("KELL", arena);
    for (let i = 0; i < 8; i++) joinLobby(lobby, `P${i}`);
    expect(lobby.seats.size).toBe(8);
    expect(() => joinLobby(lobby, "X")).toThrow(/lobby_full/);

    const lobby2 = createLobby("K2", arena);
    joinLobby(lobby2, "Alex");
    expect(joinLobby(lobby2, "Alex").seat.nickname).toBe("Alex2");
  });

  it("no claims before start, but the server remembers where you stand", () => {
    const lobby = createLobby("KELL", arena);
    const { seat } = joinLobby(lobby, "Sam");
    const p = at(120, -40);
    const effects = applyFix(lobby, seat.id, fixAt(p, 1), 1000);
    expect(effects.some((e) => e.kind === "rejected")).toBe(true);
    expect(seat.owned).toHaveLength(0);
    expect(haversineM(seat.position!.lat, seat.position!.lon, p.lat, p.lon)).toBeLessThan(0.1);
  });

  it("8 ring-placed starters are pairwise disjoint", () => {
    const lobby = createLobby("OCT", arena, { durationMs: 120_000 });
    for (let i = 0; i < 8; i++) joinLobby(lobby, `P${i}`);
    const t0 = 9_100_000;
    startLobby(lobby, t0);
    const seats = [...lobby.seats.values()];
    for (const s of seats) {
      applyFix(lobby, s.id, fixAt(s.respawnAt!, t0 + s.id), t0 + s.id);
      expect(s.mode).toBe("safe");
    }
    for (const a of seats) {
      for (const b of seats) {
        if (a === b) continue;
        expect(pointInTerritory(a.position!, b.owned)).toBe(false);
      }
    }
  });
});

describe("spawning (your circle is where YOU are)", () => {
  it("plants the starter centred on the player's real position", () => {
    const { seats } = liveLobby([[130, 75]]);
    const s = seats[0]!;
    expect(s.mode).toBe("safe");
    expect(pointInTerritory(at(130, 75), s.owned)).toBe(true);
    expect(s.areaM2).toBeGreaterThan(1400);
    expect(s.areaM2).toBeLessThan(1600);
  });

  it("a phone with no GPS before start: marker follows the first real fix", () => {
    const lobby = createLobby("NOGPS", arena);
    const { seat } = joinLobby(lobby, "Late");
    startLobby(lobby, 10);
    const ring = seat.respawnAt!;
    const me = at(-210, 160);
    applyFix(lobby, seat.id, fixAt(me, 20, { plant: false }), 20);
    expect(seat.mode).toBe("toPlant");
    expect(haversineM(seat.respawnAt!.lat, seat.respawnAt!.lon, me.lat, me.lon)).toBeLessThan(1);
    expect(haversineM(ring.lat, ring.lon, me.lat, me.lon)).toBeGreaterThan(100);
    applyFix(lobby, seat.id, fixAt(me, 30, { plant: true }), 30);
    expect(seat.mode).toBe("safe");
    expect(pointInTerritory(me, seat.owned)).toBe(true);
  });

  it("plant:false never plants; plant:true plants", () => {
    const lobby = createLobby("MAN", arena);
    const { seat } = joinLobby(lobby, "You");
    applyFix(lobby, seat.id, fixAt(at(10, 10), 1), 1);
    startLobby(lobby, 5);
    applyFix(lobby, seat.id, fixAt(at(10, 10), 10, { plant: false }), 10);
    expect(seat.mode).toBe("toPlant");
    applyFix(lobby, seat.id, fixAt(at(10, 10), 20, { plant: true }), 20);
    expect(seat.mode).toBe("safe");
  });

  it("standing next to someone: starter is pushed clear of their land", () => {
    const { seats } = liveLobby([
      [0, 0],
      [15, 0],
    ]);
    const [a, b] = seats as [Seat, Seat];
    expect(a.mode).toBe("safe");
    // B was too close to plant on the spot — marker sits clear of A.
    expect(b.mode).toBe("toPlant");
    const m = b.respawnAt!;
    expect(haversineM(m.lat, m.lon, C.lat, C.lon)).toBeGreaterThanOrEqual(
      arena.starterRadiusM * 2 - 0.5,
    );
  });
});

describe("trails + capture (paper.io fill)", () => {
  it("leaving land opens a visible trail that runs to the head", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    walk(lobby, s, [[40, 0]], clock);
    expect(s.mode).toBe("trailing");
    expect(s.trail.length).toBeGreaterThanOrEqual(6);
    const fc = buildTrailPaint([{ ...s, position: s.position }]);
    expect(fc.features).toHaveLength(1);
    const coords = fc.features[0]!.geometry.coordinates;
    expect(coords.length).toBeGreaterThanOrEqual(2);
    const tip = coords[coords.length - 1]!;
    expect(tip[0]).toBeCloseTo(s.position!.lon, 9);
    expect(tip[1]).toBeCloseTo(s.position!.lat, 9);
  });

  it("fills exactly the enclosed (concave) region — not a convex hull", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    walk(lobby, s, [[30, 0], [60, 0], [60, 50], [45, 50], [45, 12], [12, 12]], clock);
    expect(s.mode).toBe("safe");
    expect(s.trail).toHaveLength(0);
    expect(pointInTerritory(at(52, 30), s.owned)).toBe(true); // inside the loop
    expect(pointInTerritory(at(35, 6), s.owned)).toBe(true); // inside the loop
    expect(pointInTerritory(at(33, 40), s.owned)).toBe(false); // hull-only notch
    expect(pointInTerritory(at(-50, 0), s.owned)).toBe(false);
  });

  it("thin out-and-back claims a corridor, not a giant triangle", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    const before = s.areaM2;
    walk(lobby, s, [[80, 0], [80, 6], [10, 6]], clock);
    expect(s.mode).toBe("safe");
    const gained = s.areaM2 - before;
    expect(gained).toBeGreaterThan(300);
    expect(gained).toBeLessThan(900);
  });

  it("looping through an enemy's land steals just the enclosed part", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [80, 0],
    ]);
    const [a, b] = seats as [Seat, Seat];
    const bBefore = b.areaM2;
    walk(lobby, a, [[30, 0], [70, -30], [70, 30], [10, 10]], clock);
    expect(a.mode).toBe("safe");
    expect(b.mode).toBe("safe");
    expect(b.areaM2).toBeLessThan(bBefore);
    expect(b.areaM2).toBeGreaterThan(0);
    expect(pointInTerritory(at(65, 0), a.owned)).toBe(true);
    expect(pointInTerritory(at(65, 0), b.owned)).toBe(false);
    expect(pointInTerritory(at(95, 0), b.owned)).toBe(true);
  });

  it("enclosing an enemy's whole territory eliminates them", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [100, 0],
    ]);
    const [a, b] = seats as [Seat, Seat];
    walk(lobby, a, [[20, -40], [140, -40], [140, 40], [20, 40], [10, 10]], clock);
    expect(a.mode).toBe("safe");
    expect(b.owned).toHaveLength(0);
    expect(b.mode).toBe("ghost");
    expect(b.lastDeath?.reason).toBe("captured");
    expect(b.lastDeath?.byId).toBe(a.id);
  });

  it("after banks, every probe point has at most one owner", () => {
    const { lobby, seats, clock } = liveLobby([
      [-35, 0],
      [35, 0],
    ]);
    const [a, b] = seats as [Seat, Seat];
    walk(lobby, a, [[-10, -40], [20, -40], [20, 40], [-20, 40], [-30, 10]], clock);
    walk(lobby, b, [[10, -30], [-15, -30], [-15, 30], [20, 30], [30, 10]], clock);
    for (let x = -80; x <= 80; x += 5) {
      for (let y = -60; y <= 60; y += 5) {
        const p = at(x, y);
        const owners =
          Number(pointInTerritory(p, a.owned)) + Number(pointInTerritory(p, b.owned));
        expect(owners).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("cuts, self-cut, respawn", () => {
  it("touching an open trail cuts it: land neutral, no teleport, ghost then respawn", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [0, 120],
    ]);
    const [a, b] = seats as [Seat, Seat];
    walk(lobby, a, [[60, 0], [60, 60]], clock);
    expect(a.mode).toBe("trailing");
    const aPos = { ...a.position! };
    const bAreaBefore = b.areaM2;
    walk(lobby, b, [[60, 100], [60, 63]], clock);
    expect(a.mode).toBe("ghost");
    expect(a.owned).toHaveLength(0);
    expect(a.trail).toHaveLength(0);
    expect(a.areaM2).toBe(0);
    expect(a.lastDeath).toMatchObject({ byId: b.id, reason: "cut" });
    expect(b.areaM2).toBeLessThanOrEqual(bAreaBefore + 1); // land is not handed to the cutter
    // No teleport: still where they physically were.
    expect(haversineM(a.position!.lat, a.position!.lon, aPos.lat, aPos.lon)).toBeLessThan(0.01);

    // Ghost: fixes ignored for gameplay until ghostMs passes.
    applyFix(lobby, a.id, fixAt(aPos, clock.t + 100), clock.t + 100);
    expect(a.mode).toBe("ghost");
    clock.t += lobby.ghostMs + 10;
    tickLobby(lobby, clock.t);
    expect(a.mode).toBe("toPlant");
    expect(a.respawnAt).not.toBeNull();
    applyFix(lobby, a.id, fixAt(a.respawnAt!, clock.t + 1), clock.t + 1);
    expect(a.mode).toBe("safe");
    expect(pointInTerritory(a.position!, a.owned)).toBe(true);
    // Respawned near where they died, not across the map.
    expect(haversineM(a.position!.lat, a.position!.lon, aPos.lat, aPos.lon)).toBeLessThan(60);
  });

  it("respawn ring: shown at death, ≥1.6R from the body, plants when you walk in", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [0, 120],
    ]);
    const [a, b] = seats as [Seat, Seat];
    walk(lobby, a, [[60, 0], [60, 60]], clock);
    walk(lobby, b, [[60, 100], [60, 63]], clock);
    expect(a.mode).toBe("ghost");
    const died = a.lastDeath!.at!;
    const ring = a.respawnAt!;
    const R = arena.starterRadiusM;
    expect(ring).not.toBeNull(); // visible during the ghost window
    const d = haversineM(died.lat, died.lon, ring.lat, ring.lon);
    expect(d).toBeGreaterThanOrEqual(1.6 * R - 0.5);
    expect(d).toBeLessThan(6 * R);
    // Still a ghost: even standing in the ring does not plant.
    applyFix(lobby, a.id, fixAt(ring, clock.t + 100), clock.t + 100);
    expect(a.mode).toBe("ghost");
    // After the ghost window, standing where you died does not plant…
    clock.t += lobby.ghostMs + 50;
    applyFix(lobby, a.id, fixAt(died, clock.t), clock.t);
    expect(a.mode).toBe("toPlant");
    // …and the ring does not chase you.
    expect(haversineM(a.respawnAt!.lat, a.respawnAt!.lon, ring.lat, ring.lon)).toBeLessThan(0.01);
    // Walk into the ring → planted, centred on the ring.
    for (let i = 1; i <= 60 && a.mode !== "safe"; i++) {
      const k = i / 60;
      const p = { lat: died.lat + (ring.lat - died.lat) * k, lon: died.lon + (ring.lon - died.lon) * k };
      clock.t += 400;
      applyFix(lobby, a.id, fixAt(p, clock.t), clock.t);
      // Planted the moment we cross into the ring — not before.
      if (a.mode === "safe") {
        expect(haversineM(p.lat, p.lon, ring.lat, ring.lon)).toBeLessThanOrEqual(R + 0.5);
      } else {
        expect(haversineM(p.lat, p.lon, ring.lat, ring.lon)).toBeGreaterThan(R - 1.5);
      }
    }
    expect(a.mode).toBe("safe");
    expect(pointInTerritory(ring, a.owned)).toBe(true);
    expect(lobby.pops.some((p) => p.seatId === a.id)).toBe(true);
  });

  it("you can cut a raider's trail while standing in your own land", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [70, 0],
    ]);
    const [a, b] = seats as [Seat, Seat];
    // A raids into B's land.
    walk(lobby, a, [[40, 0], [60, 5]], clock);
    expect(a.mode).toBe("trailing");
    expect(pointInTerritory(b.position!, b.owned)).toBe(true);
    walk(lobby, b, [[60, 3]], clock);
    expect(b.mode).toBe("safe");
    expect(a.mode).toBe("ghost");
  });

  it("a fast step that jumps over a trail still cuts it (segment sweep)", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [0, 120],
    ]);
    const [a, b] = seats as [Seat, Seat];
    walk(lobby, a, [[60, 0], [60, 60]], clock);
    walk(lobby, b, [[50, 100], [50, 40]], clock);
    expect(a.mode).toBe("trailing");
    // B: 50,40 → 70,40 in one 20 m fix (endpoints are 10 m from the trail).
    clock.t += 5000;
    applyFix(lobby, b.id, fixAt(at(70, 40), clock.t, { speedMps: 4 }), clock.t);
    expect(a.mode).toBe("ghost");
  });

  it("crossing your own trail is allowed (no self-cut); the loop still banks", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    const before = s.areaM2;
    walk(lobby, s, [[60, 0], [60, 30], [40, 30], [40, -20], [15, -10]], clock);
    expect(s.lastDeath).toBeNull();
    expect(s.mode).toBe("safe");
    expect(s.areaM2).toBeGreaterThan(before);
  });

  it("GPS wobble while standing outside keeps you trailing", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    walk(lobby, s, [[50, 0]], clock);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (let i = 0; i < 120; i++) {
      clock.t += 1000;
      const p = at(50 + rnd() * 5, rnd() * 5);
      applyFix(lobby, s.id, fixAt(p, clock.t, { accuracyM: 6 }), clock.t);
    }
    expect(s.mode).toBe("trailing");
  });

  it("boundary soft-push keeps position inside the circle", () => {
    const { lobby, seats, clock } = liveLobby([[0, 0]]);
    const s = seats[0]!;
    const effects = applyFix(lobby, s.id, fixAt(at(800, 0), clock.t + 1), clock.t + 1);
    expect(effects.some((e) => e.kind === "boundaryPush")).toBe(true);
    expect(isInsideArena(arena, s.position!, 1)).toBe(true);
  });
});

describe("match end + rematch", () => {
  it("ends lobby and ranks top 3 by area", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [100, 0],
      [0, 100],
      [-100, 0],
    ]);
    walk(lobby, seats[3]!, [[-130, 0], [-130, 35], [-100, 35], [-100, 10]], clock);
    const effects = tickLobby(lobby, clock.t + 11 * 60_000);
    expect(lobby.phase).toBe("ended");
    expect(effects.some((e) => e.kind === "phase")).toBe(true);
    const top = topScores(lobby, 3);
    expect(top).toHaveLength(3);
    expect(top[0]!.id).toBe(seats[3]!.id);
  });

  it("rematch resets land and respawns everyone where they stand", () => {
    const { lobby, seats, clock } = liveLobby([
      [0, 0],
      [100, 0],
    ]);
    const [a] = seats as [Seat, Seat];
    tickLobby(lobby, clock.t + 11 * 60_000);
    expect(lobby.phase).toBe("ended");
    expect(() => startRematch(lobby, clock.t + 11 * 60_000)).toThrow(/need_rematch_ready/);
    markRematchReady(lobby, a.id);
    const fx = startRematch(lobby, clock.t + 12 * 60_000);
    expect(lobby.phase).toBe("live");
    expect(fx.some((e) => e.kind === "phase")).toBe(true);
    expect(a.mode).toBe("toPlant");
    expect(a.owned).toHaveLength(0);
    expect(haversineM(a.respawnAt!.lat, a.respawnAt!.lon, C.lat, C.lon)).toBeLessThan(1);
  });
});
