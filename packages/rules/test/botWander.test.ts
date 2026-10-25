import { describe, expect, it } from "vitest";
import {
  buildKellerArena,
  createLobby,
  joinLobby,
  mulberry32,
  pointInRing,
  seatPublicView,
  startLobby,
  wanderSeat,
} from "../src/index.js";

describe("wanderSeat", () => {
  it("plants then takes human-scale steps (not teleport hops)", () => {
    const arena = buildKellerArena();
    const lobby = createLobby("W", arena, { durationMs: 60_000 });
    joinLobby(lobby, "Bot1");
    const t0 = Date.UTC(2026, 1, 1);
    startLobby(lobby, t0);
    const seat = [...lobby.seats.values()][0]!;
    const rand = mulberry32(7);
    for (let i = 0; i < 120; i++) {
      wanderSeat(lobby, seat.id, rand, t0 + 200 + i * 200);
      if (seat.mode === "safe" || seat.mode === "trailing") break;
    }
    expect(["safe", "trailing"]).toContain(seat.mode);
    expect(seat.position).not.toBeNull();
    const a = { ...seat.position! };
    wanderSeat(lobby, seat.id, rand, t0 + 50_000);
    const b = seat.position!;
    const dLat = (b.lat - a.lat) * 111320;
    const dLon =
      (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const dist = Math.hypot(dLat, dLon);
    expect(dist).toBeLessThan(1.5);
    expect(dist).toBeGreaterThan(0.05);
  });

  it("leaves starter and grows an open trail in the client payload", () => {
    const arena = buildKellerArena();
    const lobby = createLobby("TR", arena, { durationMs: 120_000 });
    joinLobby(lobby, "Bot1");
    joinLobby(lobby, "Bot2");
    const t0 = Date.UTC(2026, 3, 1);
    startLobby(lobby, t0);
    const seats = [...lobby.seats.values()];
    const rand = mulberry32(99);
    let maxTrail = 0;
    let leftZone = false;
    let sawTrailingPayload = false;
    for (let i = 0; i < 600; i++) {
      const now = t0 + i * 200;
      for (const s of seats) wanderSeat(lobby, s.id, rand, now);
      for (const s of seats) {
        const view = seatPublicView(s);
        maxTrail = Math.max(maxTrail, view.trail.length);
        if (view.mode === "trailing" && view.trail.length >= 2) {
          sawTrailingPayload = true;
          if (s.owned[0] && s.position && !pointInRing(s.position, s.owned[0])) {
            leftZone = true;
          }
        }
      }
      if (sawTrailingPayload && leftZone && maxTrail >= 8) break;
    }
    expect(sawTrailingPayload).toBe(true);
    expect(leftZone).toBe(true);
    expect(maxTrail).toBeGreaterThanOrEqual(8);
  });
});
