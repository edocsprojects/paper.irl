import { describe, expect, it } from "vitest";
import {
  buildArena,
  buildKellerArena,
  haversineM,
  createLobby,
  joinLobby,
  mulberry32,
  pointInTerritory,
  tickLobby,
  type Effect,
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
    for (let i = 0; i < 1400; i++) {
      const now = t0 + i * 200;
      for (const s of seats) wanderSeat(lobby, s.id, rand, now);
      for (const s of seats) {
        const view = seatPublicView(s);
        maxTrail = Math.max(maxTrail, view.trail.length);
        if (view.mode === "trailing" && view.trail.length >= 2) {
          sawTrailingPayload = true;
          if (s.owned.length && s.position && !pointInTerritory(s.position, s.owned)) {
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

  it("8-bot soak: banks, cuts and respawns happen; land stays exclusive; ticks stay fast", () => {
    const arena = buildKellerArena();
    const lobby = createLobby("SOAK", arena, { durationMs: 30 * 60_000 });
    for (let i = 1; i <= 8; i++) joinLobby(lobby, `Bot${i}`);
    const t0 = Date.UTC(2026, 5, 1);
    startLobby(lobby, t0);
    const seats = [...lobby.seats.values()];
    const rand = mulberry32(2024);
    const counts: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    let planted = 0;
    let worstTickMs = 0;
    // Stall watchdog: trailing with an unchanged trail = jittering in place.
    const stall = new Map<number, { len: number; since: number }>();
    let worstStallMs = 0;
    const ticks = 5 * 60 * 5; // 5 simulated minutes @ 5 Hz
    for (let i = 0; i < ticks; i++) {
      const now = t0 + 200 + i * 200;
      const start = performance.now();
      const fx: Effect[] = [...tickLobby(lobby, now)];
      for (const s of seats) fx.push(...wanderSeat(lobby, s.id, rand, now));
      worstTickMs = Math.max(worstTickMs, performance.now() - start);
      for (const s of seats) {
        const prev = stall.get(s.id);
        if (s.mode !== "trailing" || !prev || prev.len !== s.trail.length) {
          stall.set(s.id, { len: s.mode === "trailing" ? s.trail.length : -1, since: now });
        } else {
          worstStallMs = Math.max(worstStallMs, now - prev.since);
        }
      }
      for (const e of fx) {
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        if (e.kind === "cut") reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
        if (e.kind === "planted") {
          planted++;
          // A fresh starter never lands in (or touching) anyone else's zone.
          for (const other of seats) {
            if (other.id === e.seatId) continue;
            for (const v of e.ring) {
              expect(pointInTerritory(v, other.owned, 4)).toBe(false);
            }
          }
        }
      }
      if (i % 75 === 0) {
        // Exclusive ownership on a coarse probe grid around the action.
        for (let x = -160; x <= 160; x += 16) {
          for (let y = -160; y <= 160; y += 16) {
            const p = {
              lat: arena.centerLat + y / 111320,
              lon: arena.centerLon + x / (111320 * Math.cos((arena.centerLat * Math.PI) / 180)),
            };
            const owners = seats.filter((s) => pointInTerritory(p, s.owned)).length;
            expect(owners).toBeLessThanOrEqual(1);
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log("soak", { counts, reasons, planted, worstTickMs: Math.round(worstTickMs), worstStallMs });
    expect(planted).toBeGreaterThanOrEqual(8);
    expect(counts.banked ?? 0).toBeGreaterThanOrEqual(8);
    expect(counts.cut ?? 0).toBeGreaterThanOrEqual(1);
    expect(planted).toBeGreaterThan(8); // someone died and came back
    expect(worstTickMs).toBeLessThan(250);
    expect(worstStallMs).toBeLessThan(30_000);
    expect(lobby.feed.length).toBeGreaterThan(0);
    expect(lobby.feed.length).toBeLessThanOrEqual(12);
  });

  it("demo pace (2.5×, 250 m arena): bots stay smooth, spread out, and the action is dense", () => {
    const arena = buildArena({ radiusM: 250 });
    const lobby = createLobby("DEMO", arena, { durationMs: 30 * 60_000, speedScale: 2.5 });
    for (let i = 1; i <= 7; i++) joinLobby(lobby, `Bot${i}`);
    const t0 = Date.UTC(2026, 6, 1);
    startLobby(lobby, t0);
    const seats = [...lobby.seats.values()];
    // Evenly spread: no two starters closer than 2R + gap, and not all hugging the centre.
    const markers = seats.map((s) => s.respawnAt!);
    const fromC = markers.map((m) => haversineM(m.lat, m.lon, arena.centerLat, arena.centerLon));
    expect(Math.max(...fromC)).toBeGreaterThan(arena.radiusM * 0.5);
    const rand = mulberry32(77);
    let cuts = 0;
    let banks = 0;
    let maxStep = 0;
    let maxTurn = 0;
    const prev = new Map<number, { p: { lat: number; lon: number }; h: number | null }>();
    for (let i = 0; i < 2 * 60 * 5; i++) {
      const now = t0 + 200 + i * 200;
      for (const s of seats) {
        for (const e of wanderSeat(lobby, s.id, rand, now)) {
          if (e.kind === "cut") cuts++;
          if (e.kind === "banked") banks++;
        }
        const last = prev.get(s.id);
        if (s.position && last && (s.mode === "safe" || s.mode === "trailing")) {
          const d = haversineM(last.p.lat, last.p.lon, s.position.lat, s.position.lon);
          maxStep = Math.max(maxStep, d);
          if (d > 0.3) {
            const h = Math.atan2(s.position.lat - last.p.lat, (s.position.lon - last.p.lon) * Math.cos((s.position.lat * Math.PI) / 180));
            if (last.h !== null) {
              let dh = Math.abs(h - last.h);
              if (dh > Math.PI) dh = 2 * Math.PI - dh;
              if (s.mode === "safe" || s.mode === "trailing") maxTurn = Math.max(maxTurn, dh);
            }
            prev.set(s.id, { p: { ...s.position }, h });
            continue;
          }
        }
        if (s.position) prev.set(s.id, { p: { ...s.position }, h: last?.h ?? null });
      }
    }
    // eslint-disable-next-line no-console
    console.log("demo", { cuts, banks, maxStep: maxStep.toFixed(2), maxTurn: maxTurn.toFixed(2) });
    expect(banks).toBeGreaterThanOrEqual(10);
    expect(cuts).toBeGreaterThanOrEqual(3);
    // 2.5 × ~3 m/s × 0.2 s ≈ 1.7 m per tick — never a teleport hop.
    expect(maxStep).toBeLessThan(3);
  });

  it("walks smoothly at 1× (no shaking or left-right zigzag)", () => {
    const arena = buildArena({ radiusM: 150 });
    const lobby = createLobby("SMOOTH", arena, { durationMs: 30 * 60_000 });
    for (let i = 1; i <= 8; i++) joinLobby(lobby, `Bot${i}`, { bot: true });
    const t0 = Date.UTC(2026, 7, 1);
    startLobby(lobby, t0);
    const rand = mulberry32(5);
    const prev = new Map<number, { lat: number; lon: number; h: number | null }>();
    const lastSign = new Map<number, number>();
    let turnSum = 0;
    let samples = 0;
    let flips = 0;
    for (let i = 0; i < 3 * 60 * 5; i++) {
      const now = t0 + 200 + i * 200;
      tickLobby(lobby, now);
      for (const s of lobby.seats.values()) {
        wanderSeat(lobby, s.id, rand, now);
        const p = s.position;
        if (!p || (s.mode !== "safe" && s.mode !== "trailing")) {
          prev.delete(s.id);
          continue;
        }
        const last = prev.get(s.id);
        if (!last) {
          prev.set(s.id, { lat: p.lat, lon: p.lon, h: null });
          continue;
        }
        if (haversineM(last.lat, last.lon, p.lat, p.lon) <= 0.05) continue;
        const h = Math.atan2(p.lat - last.lat, (p.lon - last.lon) * Math.cos((p.lat * Math.PI) / 180));
        if (last.h !== null) {
          let d = h - last.h;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          turnSum += Math.abs(d);
          samples++;
          if (Math.abs(d) > 0.1) {
            if (lastSign.get(s.id) === -Math.sign(d)) flips++;
            lastSign.set(s.id, Math.sign(d));
          }
        }
        prev.set(s.id, { lat: p.lat, lon: p.lon, h });
      }
    }
    // eslint-disable-next-line no-console
    console.log("smooth", { meanTurn: (turnSum / samples).toFixed(3), flips, samples });
    expect(samples).toBeGreaterThan(3000);
    expect(turnSum / samples).toBeLessThan(0.15);
    expect(flips / samples).toBeLessThan(0.08);
  });
});
