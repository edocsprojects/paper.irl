import { describe, expect, it } from "vitest";
import {
  applyFix,
  buildKellerArena,
  createLobby,
  fromLocalM,
  joinLobby,
  ringAreaM2,
  startLobby,
  tickLobby,
  topScores,
} from "../src/index.js";

const arena = buildKellerArena();

function fixAt(
  lat: number,
  lon: number,
  t: number,
  opts?: { speedMps?: number; accuracyM?: number },
) {
  return {
    lat,
    lon,
    accuracyM: opts?.accuracyM ?? 8,
    speedMps: opts?.speedMps ?? 2,
    clientTsMs: t,
  };
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
    for (let i = 0; i < 8; i++) {
      joinLobby(lobby, `P${i}`);
    }
    expect(lobby.seats.size).toBe(8);
    expect(() => joinLobby(lobby, "X")).toThrow(/lobby_full/);

    const lobby2 = createLobby("K2", arena);
    joinLobby(lobby2, "Alex");
    const { seat } = joinLobby(lobby2, "Alex");
    expect(seat.nickname).toBe("Alex2");
  });

  it("requires host start before claims", () => {
    const lobby = createLobby("KELL", arena);
    const { seat } = joinLobby(lobby, "Sam");
    const effects = applyFix(
      lobby,
      seat.id,
      fixAt(arena.centerLat, arena.centerLon, 1),
      1000,
    );
    expect(effects.some((e) => e.kind === "rejected")).toBe(true);
  });
});

describe("plant trail bank cut wipe (freeplay)", () => {
  it("plants only near respawn marker then can trail and bank a loop", () => {
    const lobby = createLobby("KELL", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "A");
    const t0 = 1_000_000;
    startLobby(lobby, t0);
    expect(seat.mode).toBe("toPlant");
    expect(seat.respawnAt).not.toBeNull();

    const far = fromLocalM(arena.centerLat, arena.centerLon, 200, 0);
    applyFix(lobby, seat.id, fixAt(far.lat, far.lon, t0 + 100), t0 + 100);
    expect(seat.mode).toBe("toPlant");
    expect(seat.owned.length).toBe(0);

    applyFix(
      lobby,
      seat.id,
      fixAt(seat.respawnAt!.lat, seat.respawnAt!.lon, t0 + 200),
      t0 + 200,
    );
    expect(seat.mode).toBe("safe");
    expect(seat.owned.length).toBe(1);
    expect(seat.areaM2).toBeGreaterThan(500);

    const home = seat.position!;
    // Walk a square that returns home → bank
    const offsets: [number, number][] = [
      [40, 0],
      [40, 40],
      [0, 40],
      [0, 5],
    ];
    let t = t0 + 300;
    for (const [x, y] of offsets) {
      const p = fromLocalM(home.lat, home.lon, x, y);
      applyFix(lobby, seat.id, fixAt(p.lat, p.lon, t), t);
      t += 100;
    }
    expect(seat.mode).toBe("safe");
    expect(seat.trail.length).toBe(0);
    expect(seat.owned.length).toBeGreaterThanOrEqual(2);
    expect(seat.areaM2).toBeGreaterThan(ringAreaM2(seat.owned[0]!));
  });

  it("wipe sends land to neutral and requires respawn before play", () => {
    const lobby = createLobby("KELL", arena, { durationMs: 120_000 });
    const a = joinLobby(lobby, "A").seat;
    const b = joinLobby(lobby, "B").seat;
    const t0 = 2_000_000;
    startLobby(lobby, t0);

    applyFix(
      lobby,
      a.id,
      fixAt(a.respawnAt!.lat, a.respawnAt!.lon, t0 + 1),
      t0 + 1,
    );
    applyFix(
      lobby,
      b.id,
      fixAt(b.respawnAt!.lat, b.respawnAt!.lon, t0 + 2),
      t0 + 2,
    );
    expect(a.mode).toBe("safe");
    expect(b.mode).toBe("safe");

    const home = a.position!;
    // Stay well outside starter disk (~22 m) + edge slack so we don't auto-bank.
    const p1 = fromLocalM(home.lat, home.lon, 45, 0);
    const p2 = fromLocalM(home.lat, home.lon, 70, 0);
    const p3 = fromLocalM(home.lat, home.lon, 95, 0);
    applyFix(lobby, a.id, fixAt(p1.lat, p1.lon, t0 + 10), t0 + 10);
    applyFix(lobby, a.id, fixAt(p2.lat, p2.lon, t0 + 12), t0 + 12);
    applyFix(lobby, a.id, fixAt(p3.lat, p3.lon, t0 + 15), t0 + 15);
    expect(a.mode).toBe("trailing");
    expect(a.trail.length).toBeGreaterThan(1);

    const beforeOwned = a.owned.length;
    expect(beforeOwned).toBeGreaterThan(0);

    // B steps onto A's open trail (far from A's home)
    applyFix(lobby, b.id, fixAt(p2.lat, p2.lon, t0 + 20), t0 + 20);

    expect(a.owned.length).toBe(0);
    expect(a.areaM2).toBe(0);
    expect(a.mode).toBe("toPlant");
    expect(a.respawnAt).not.toBeNull();

    const elsewhere = fromLocalM(arena.centerLat, arena.centerLon, -150, 80);
    applyFix(
      lobby,
      a.id,
      fixAt(elsewhere.lat, elsewhere.lon, t0 + 30),
      t0 + 30,
    );
    expect(a.mode).toBe("toPlant");
    expect(a.owned.length).toBe(0);
  });

  it("soft-pushes fixes that leave the Keller circle", () => {
    const lobby = createLobby("KELL", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "A");
    const t0 = 4_000_000;
    startLobby(lobby, t0);
    applyFix(
      lobby,
      seat.id,
      fixAt(seat.respawnAt!.lat, seat.respawnAt!.lon, t0 + 1),
      t0 + 1,
    );
    const wayOut = fromLocalM(arena.centerLat, arena.centerLon, 800, 0);
    const effects = applyFix(
      lobby,
      seat.id,
      fixAt(wayOut.lat, wayOut.lon, t0 + 2),
      t0 + 2,
    );
    expect(effects.some((e) => e.kind === "boundaryPush")).toBe(true);
    expect(seat.position).not.toBeNull();
    const d = Math.hypot(
      ...(() => {
        const dx =
          (seat.position!.lon - arena.centerLon) *
          111320 *
          Math.cos((arena.centerLat * Math.PI) / 180);
        const dy = (seat.position!.lat - arena.centerLat) * 111320;
        return [dx, dy] as const;
      })(),
    );
    expect(d).toBeLessThanOrEqual(arena.radiusM + 1);
  });

  it("ends lobby and ranks top 3 by area", () => {
    const lobby = createLobby("KELL", arena, { durationMs: 5_000 });
    const seats = ["A", "B", "C", "D"].map((n) => joinLobby(lobby, n).seat);
    const t0 = 3_000_000;
    startLobby(lobby, t0);
    for (const s of seats) {
      applyFix(
        lobby,
        s.id,
        fixAt(s.respawnAt!.lat, s.respawnAt!.lon, t0 + 1),
        t0 + 1,
      );
    }
    // Give D a banked loop for more area
    const d = seats[3]!;
    const home = d.position!;
    let t = t0 + 2;
    for (const [x, y] of [
      [35, 0],
      [35, 35],
      [0, 35],
      [0, 4],
    ] as [number, number][]) {
      const p = fromLocalM(home.lat, home.lon, x, y);
      applyFix(lobby, d.id, fixAt(p.lat, p.lon, t), t);
      t += 1;
    }

    const effects = tickLobby(lobby, t0 + 6_000);
    expect(lobby.phase).toBe("ended");
    expect(effects.some((e) => e.kind === "phase")).toBe(true);
    const top = topScores(lobby, 3);
    expect(top).toHaveLength(3);
    expect(top[0]!.areaM2).toBeGreaterThanOrEqual(top[1]!.areaM2);
  });
});
