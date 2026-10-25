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
    // plant at respawn
    wanderSeat(lobby, seat.id, rand, t0 + 1000);
    expect(["safe", "toPlant", "trailing"]).toContain(seat.mode);
    for (let i = 0; i < 20; i++) {
      wanderSeat(lobby, seat.id, rand, t0 + 2000 + i * 1000);
    }
    expect(seat.mode).not.toBe("joining");
  });
});
