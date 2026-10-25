import { describe, expect, it } from "vitest";
import {
  buildKellerArena,
  createLobby,
  joinLobby,
  mulberry32,
  startLobby,
  wanderSeat,
} from "../src/index.js";

describe("wanderSeat", () => {
  it("moves a bot after plant without throwing", () => {
    const arena = buildKellerArena();
    const lobby = createLobby("W", arena, { durationMs: 60_000 });
    joinLobby(lobby, "Bot1");
    const t0 = Date.UTC(2026, 1, 1);
    startLobby(lobby, t0);
    const seat = [...lobby.seats.values()][0]!;
    const rand = mulberry32(7);
    // plant at respawn (may take a few human-scale steps)
    for (let i = 0; i < 80; i++) {
      wanderSeat(lobby, seat.id, rand, t0 + 200 + i * 200);
      if (seat.mode === "safe" || seat.mode === "trailing") break;
    }
    expect(["safe", "toPlant", "trailing"]).toContain(seat.mode);
    for (let i = 0; i < 40; i++) {
      wanderSeat(lobby, seat.id, rand, t0 + 20_000 + i * 200);
    }
    expect(seat.mode).not.toBe("joining");
  });

  it("takes human-scale steps (not teleport hops)", () => {
    const arena = buildKellerArena();
    const lobby = createLobby("W2", arena, { durationMs: 60_000 });
    joinLobby(lobby, "Bot1");
    const t0 = Date.UTC(2026, 2, 1);
    startLobby(lobby, t0);
    const seat = [...lobby.seats.values()][0]!;
    const rand = mulberry32(11);
    for (let i = 0; i < 100; i++) {
      wanderSeat(lobby, seat.id, rand, t0 + i * 200);
      if (seat.mode === "safe") break;
    }
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
});
