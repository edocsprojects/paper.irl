import { describe, expect, it } from "vitest";
import {
  applyFix,
  buildKellerArena,
  buildTrailPaint,
  createLobby,
  fromLocalM,
  joinLobby,
  startLobby,
} from "../src/index.js";

const arena = buildKellerArena();

function fixAt(lat: number, lon: number, t: number) {
  return {
    lat,
    lon,
    accuracyM: 8,
    speedMps: 2,
    clientTsMs: t,
  };
}

describe("trail paint payload", () => {
  it("outside own territory ⇒ trail ≥2 points and LineString on trail layer", () => {
    const lobby = createLobby("TRL", arena, { durationMs: 60_000 });
    const { seat } = joinLobby(lobby, "You");
    const t0 = 7_000_000;
    startLobby(lobby, t0);
    applyFix(
      lobby,
      seat.id,
      fixAt(seat.respawnAt!.lat, seat.respawnAt!.lon, t0 + 1),
      t0 + 1,
    );
    expect(seat.mode).toBe("safe");

    const home = seat.position!;
    const out = fromLocalM(home.lat, home.lon, 50, 0);
    applyFix(lobby, seat.id, fixAt(out.lat, out.lon, t0 + 2), t0 + 2);

    expect(seat.mode).toBe("trailing");
    expect(seat.trail.length).toBeGreaterThanOrEqual(2);

    const paint = buildTrailPaint([
      {
        id: seat.id,
        mode: seat.mode,
        trail: seat.trail,
        position: seat.position,
      },
    ]);
    expect(paint.type).toBe("FeatureCollection");
    expect(paint.features.length).toBeGreaterThanOrEqual(1);
    const feat = paint.features.find((f) => f.properties.seatId === seat.id);
    expect(feat).toBeTruthy();
    expect(feat!.geometry.type).toBe("LineString");
    expect(feat!.properties.kind).toBe("trail");
    expect(feat!.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it("fails the paint contract when trailing setData features are empty", () => {
    // Mirrors CI: empty FeatureCollection while trailing must not pass.
    const empty = buildTrailPaint([
      { id: 7, mode: "trailing", trail: [], position: { lat: 1, lon: 2 } },
    ]);
    expect(empty.features.length).toBe(0);
    expect(
      empty.features.some(
        (f) =>
          f.geometry.type === "LineString" &&
          f.geometry.coordinates.length >= 2,
      ),
    ).toBe(false);
  });

  it("safe seats with empty trails produce no trail features", () => {
    const paint = buildTrailPaint([
      { id: 1, mode: "safe", trail: [], position: { lat: 1, lon: 2 } },
    ]);
    expect(paint.features).toHaveLength(0);
  });
});
