import { describe, expect, it } from "vitest";
import {
  applyFix,
  buildKellerArena,
  circleRing,
  createLobby,
  fromLocalM,
  haversineM,
  isInsideArena,
  joinLobby,
  markRematchReady,
  pointInRing,
  ringAreaM2,
  ringsIntersectionAreaM2,
  startLobby,
  startRematch,
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

  it("late join into a live event only with allowLive, plants where they stand when free", () => {
    const lobby = createLobby("EVT", arena, { durationMs: 7 * 24 * 3600_000 });
    joinLobby(lobby, "Early");
    const t0 = 1_000_000;
    startLobby(lobby, t0);
    expect(() => joinLobby(lobby, "Late")).toThrow(/lobby_not_open/);

    const { seat } = joinLobby(lobby, "Late", { allowLive: true });
    expect(seat.mode).toBe("joining");
    const here = fromLocalM(arena.centerLat, arena.centerLon, -150, 120);
    const effects = applyFix(lobby, seat.id, fixAt(here.lat, here.lon, t0 + 100), t0 + 100);
    expect(effects.some((e) => e.kind === "planted")).toBe(true);
    expect(seat.mode).toBe("safe");
    expect(haversineM(seat.position!.lat, seat.position!.lon, here.lat, here.lon)).toBeLessThan(25);
    expect(seat.areaM2).toBeGreaterThan(0);
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

  it("places non-overlapping starter markers (no zone stack)", () => {
    const lobby = createLobby("SEP", arena, { durationMs: 60_000 });
    for (let i = 0; i < 6; i++) joinLobby(lobby, `P${i}`);
    startLobby(lobby, 9_000_000);
    const markers = [...lobby.seats.values()].map((s) => s.respawnAt!);
    const minSep = arena.starterRadiusM * 2 + 10;
    for (let i = 0; i < markers.length; i++) {
      for (let j = i + 1; j < markers.length; j++) {
        const d = haversineM(
          markers[i]!.lat,
          markers[i]!.lon,
          markers[j]!.lat,
          markers[j]!.lon,
        );
        expect(d).toBeGreaterThanOrEqual(minSep - 0.5);
      }
    }
  });

  it("8 starters are pairwise disjoint (centers ≥ 2R, intersection area 0)", () => {
    const lobby = createLobby("OCT", arena, { durationMs: 120_000 });
    for (let i = 0; i < 8; i++) joinLobby(lobby, `P${i}`);
    const t0 = 9_100_000;
    startLobby(lobby, t0);
    expect(lobby.seats.size).toBe(8);

    const minCenterSep = arena.starterRadiusM * 2;
    const seats = [...lobby.seats.values()];
    for (const s of seats) {
      applyFix(
        lobby,
        s.id,
        fixAt(s.respawnAt!.lat, s.respawnAt!.lon, t0 + s.id),
        t0 + s.id,
      );
      expect(s.mode).toBe("safe");
      expect(s.owned.length).toBe(1);
    }

    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const a = seats[i]!;
        const b = seats[j]!;
        const ca = a.position!;
        const cb = b.position!;
        const d = haversineM(ca.lat, ca.lon, cb.lat, cb.lon);
        expect(d).toBeGreaterThanOrEqual(minCenterSep - 0.5);
        expect(ringsIntersectionAreaM2(a.owned[0]!, b.owned[0]!)).toBe(0);
      }
    }
  });
});

describe("exclusive ownership + respawn + cut edges", () => {
  it("rejects respawn plant inside enemy territory or another starter", () => {
    const lobby = createLobby("REJ", arena, { durationMs: 120_000 });
    const a = joinLobby(lobby, "A").seat;
    const b = joinLobby(lobby, "B").seat;
    const t0 = 9_200_000;
    startLobby(lobby, t0);
    applyFix(
      lobby,
      a.id,
      fixAt(a.respawnAt!.lat, a.respawnAt!.lon, t0 + 1),
      t0 + 1,
    );
    expect(a.mode).toBe("safe");

    // Force B's marker into A's starter disk — plant must move/reject.
    const insideA = fromLocalM(a.position!.lat, a.position!.lon, 4, 0);
    b.respawnAt = insideA;
    b.position = insideA;
    const before = { ...insideA };
    applyFix(
      lobby,
      b.id,
      { ...fixAt(insideA.lat, insideA.lon, t0 + 2), plant: true },
      t0 + 2,
    );
    expect(b.mode).toBe("toPlant");
    expect(b.owned.length).toBe(0);
    expect(b.respawnAt).not.toBeNull();
    const moved = b.respawnAt!;
    const stillInside =
      pointInRing(moved, a.owned[0]!) ||
      haversineM(moved.lat, moved.lon, before.lat, before.lon) < 1;
    expect(stillInside).toBe(false);
    expect(
      haversineM(moved.lat, moved.lon, a.position!.lat, a.position!.lon),
    ).toBeGreaterThanOrEqual(arena.starterRadiusM * 2 - 0.5);
  });

  it("after overlapping banks, owned regions are pairwise disjoint", () => {
    const lobby = createLobby("BANK", arena, { durationMs: 180_000 });
    const a = joinLobby(lobby, "A").seat;
    const b = joinLobby(lobby, "B").seat;
    const t0 = 9_300_000;
    startLobby(lobby, t0);

    // Plant at forced nearby but still ≥2R centers so starters don't overlap.
    const c = { lat: arena.centerLat, lon: arena.centerLon };
    const pA = fromLocalM(c.lat, c.lon, -30, 0);
    const pB = fromLocalM(c.lat, c.lon, 30, 0);
    a.respawnAt = pA;
    b.respawnAt = pB;
    applyFix(lobby, a.id, fixAt(pA.lat, pA.lon, t0 + 1), t0 + 1);
    applyFix(lobby, b.id, fixAt(pB.lat, pB.lon, t0 + 2), t0 + 2);
    expect(a.mode).toBe("safe");
    expect(b.mode).toBe("safe");

    // Both bank loops that overlap in the midline without swallowing the
    // other starter disk (centers stay ≥2R clear of the opposing hull).
    function bankToward(
      seat: typeof a,
      home: { lat: number; lon: number },
      xSign: number,
      tBase: number,
    ) {
      const offsets: [number, number][] = [
        [40 * xSign, -28],
        [40 * xSign, 28],
        [6 * xSign, 28],
        [6 * xSign, 0],
      ];
      let t = tBase;
      for (const [x, y] of offsets) {
        const p = fromLocalM(home.lat, home.lon, x, y);
        applyFix(lobby, seat.id, fixAt(p.lat, p.lon, t), t);
        t += 1;
      }
    }
    bankToward(a, a.position!, 1, t0 + 10);
    expect(a.mode).toBe("safe");
    expect(b.owned.length).toBe(1); // A must not wipe B's starter
    bankToward(b, b.position!, -1, t0 + 20);

    expect(a.mode).toBe("safe");
    expect(b.mode).toBe("safe");
    expect(a.owned.length).toBe(1);
    expect(b.owned.length).toBe(1);

    const overlap = ringsIntersectionAreaM2(a.owned[0]!, b.owned[0]!);
    expect(overlap).toBe(0);

    // Probe grid: every point is neutral or exactly one owner.
    for (let x = -80; x <= 80; x += 10) {
      for (let y = -60; y <= 60; y += 10) {
        const p = fromLocalM(c.lat, c.lon, x, y);
        const inA = a.owned.some((r) => pointInRing(p, r));
        const inB = b.owned.some((r) => pointInRing(p, r));
        expect(Number(inA) + Number(inB)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("cut: victim land goes neutral, trail clears, not left in cutter zone", () => {
    const lobby = createLobby("CUT", arena, { durationMs: 120_000 });
    const a = joinLobby(lobby, "Victim").seat;
    const b = joinLobby(lobby, "Cutter").seat;
    const t0 = 9_400_000;
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

    const home = a.position!;
    const p1 = fromLocalM(home.lat, home.lon, 45, 0);
    const p2 = fromLocalM(home.lat, home.lon, 70, 0);
    const p3 = fromLocalM(home.lat, home.lon, 95, 0);
    applyFix(lobby, a.id, fixAt(p1.lat, p1.lon, t0 + 10), t0 + 10);
    applyFix(lobby, a.id, fixAt(p2.lat, p2.lon, t0 + 12), t0 + 12);
    applyFix(lobby, a.id, fixAt(p3.lat, p3.lon, t0 + 15), t0 + 15);
    expect(a.mode).toBe("trailing");
    expect(a.trail.length).toBeGreaterThanOrEqual(2);
    const victimAreaBefore = a.areaM2;
    expect(victimAreaBefore).toBeGreaterThan(0);
    const cutterAreaBefore = b.areaM2;

    applyFix(lobby, b.id, fixAt(p2.lat, p2.lon, t0 + 20), t0 + 20);

    // Neutral — not stolen by cutter.
    expect(a.owned.length).toBe(0);
    expect(a.areaM2).toBe(0);
    expect(a.trail.length).toBe(0);
    expect(b.areaM2).toBeLessThanOrEqual(cutterAreaBefore + 1);

    expect(a.mode).toBe("toPlant");
    expect(a.respawnAt).not.toBeNull();
    expect(a.position).not.toBeNull();
    for (const ring of b.owned) {
      expect(pointInRing(a.respawnAt!, ring)).toBe(false);
      expect(pointInRing(a.position!, ring)).toBe(false);
    }
  });

  it("boundary soft-push keeps position and territory inside the circle", () => {
    const lobby = createLobby("BND", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "A");
    const t0 = 9_500_000;
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
    expect(isInsideArena(arena, seat.position!, 1)).toBe(true);
    for (const ring of seat.owned) {
      for (const p of ring) {
        expect(isInsideArena(arena, p, arena.starterRadiusM + 2)).toBe(true);
      }
    }
    // Soft-push must not invent a ring outside the arena.
    const outsideRing = circleRing(wayOut, 30, 12);
    expect(isInsideArena(arena, outsideRing[0]!, 0)).toBe(false);
    expect(seat.owned.some((r) => ringsIntersectionAreaM2(r, outsideRing) > 1)).toBe(
      false,
    );
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
    // Bank merges into ONE connected polygon (starter ∪ loop), not detached blobs.
    expect(seat.owned.length).toBe(1);
    expect(seat.areaM2).toBeGreaterThan(500);
  });

  it("leave home → open trail grows; return home → one territory, trail clears", () => {
    const lobby = createLobby("LOOP", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "A");
    const t0 = 1_100_000;
    startLobby(lobby, t0);
    applyFix(
      lobby,
      seat.id,
      fixAt(seat.respawnAt!.lat, seat.respawnAt!.lon, t0 + 1),
      t0 + 1,
    );
    const home = seat.position!;
    const areaBefore = seat.areaM2;

    const out1 = fromLocalM(home.lat, home.lon, 45, 0);
    applyFix(lobby, seat.id, fixAt(out1.lat, out1.lon, t0 + 2), t0 + 2);
    expect(seat.mode).toBe("trailing");
    expect(seat.trail.length).toBeGreaterThanOrEqual(2);
    const lenAfterLeave = seat.trail.length;

    const out2 = fromLocalM(home.lat, home.lon, 70, 25);
    applyFix(lobby, seat.id, fixAt(out2.lat, out2.lon, t0 + 3), t0 + 3);
    expect(seat.mode).toBe("trailing");
    expect(seat.trail.length).toBeGreaterThan(lenAfterLeave);

    // Close the loop back into starter disk.
    for (const [x, y] of [
      [40, 40],
      [0, 40],
      [0, 4],
    ] as [number, number][]) {
      const p = fromLocalM(home.lat, home.lon, x, y);
      applyFix(lobby, seat.id, fixAt(p.lat, p.lon, t0 + 10 + x), t0 + 10 + x);
    }
    expect(seat.mode).toBe("safe");
    expect(seat.trail.length).toBe(0);
    expect(seat.owned.length).toBe(1);
    expect(seat.areaM2).toBeGreaterThanOrEqual(areaBefore);
  });

  it("plant:false near marker moves without planting (Manual drag)", () => {
    const lobby = createLobby("MAN", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "You");
    const t0 = 1_500_000;
    startLobby(lobby, t0);
    const at = seat.respawnAt!;
    applyFix(
      lobby,
      seat.id,
      { ...fixAt(at.lat, at.lon, t0 + 10), plant: false },
      t0 + 10,
    );
    expect(seat.mode).toBe("toPlant");
    expect(seat.owned.length).toBe(0);
    applyFix(
      lobby,
      seat.id,
      { ...fixAt(at.lat, at.lon, t0 + 20), plant: true },
      t0 + 20,
    );
    expect(seat.mode).toBe("safe");
    expect(seat.owned.length).toBe(1);
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

describe("rematch / play again", () => {
  it("marks ready then starts a fresh live match with same seats", () => {
    const lobby = createLobby("KELL", arena, { durationMs: 5_000 });
    const a = joinLobby(lobby, "A").seat;
    const b = joinLobby(lobby, "B").seat;
    const t0 = 4_000_000;
    startLobby(lobby, t0);
    applyFix(lobby, a.id, fixAt(a.respawnAt!.lat, a.respawnAt!.lon, t0 + 1), t0 + 1);
    applyFix(lobby, b.id, fixAt(b.respawnAt!.lat, b.respawnAt!.lon, t0 + 1), t0 + 1);
    tickLobby(lobby, t0 + 6_000);
    expect(lobby.phase).toBe("ended");

    expect(() => startRematch(lobby, t0 + 7_000)).toThrow(/need_rematch_ready/);
    const readyFx = markRematchReady(lobby, a.id);
    expect(readyFx.some((e) => e.kind === "rematchReady")).toBe(true);
    expect([...lobby.rematchReady]).toEqual([a.id]);

    const fx = startRematch(lobby, t0 + 8_000);
    expect(lobby.phase).toBe("live");
    expect(fx.some((e) => e.kind === "phase" && e.phase === "live")).toBe(true);
    expect(lobby.seats.size).toBe(2);
    expect(a.nickname).toBe("A");
    expect(a.mode).toBe("toPlant");
    expect(a.owned).toHaveLength(0);
    expect(a.areaM2).toBe(0);
    expect(lobby.rematchReady.size).toBe(0);
  });
});
