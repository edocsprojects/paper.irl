import Fastify from "fastify";
import {
  applyFix,
  buildArena,
  buildKellerArena,
  createLobby,
  joinLobby,
  markRematchReady,
  mulberry32,
  seatIsBot,
  seatPublicView,
  startLobby,
  startRematch,
  tickLobby,
  topScores,
  wanderSeat,
  type Fix,
  type LobbyState,
} from "@paper-irl/rules";
import { fillBots, startBotLoop, stopBotLoop, tickBots } from "./bots.js";

/**
 * Minimal HTTP API for local demos.
 * Live play state is in-memory. Postgres is optional (DATABASE_URL).
 * Freeplay MVP: GPS polylines inside Keller circle (no path-graph required).
 */
const defaultArena = buildKellerArena();
const lobbies = new Map<string, LobbyState>();

/** Fixed test lobby code so Create/Join always match on Simulator. */
const DEMO_LOBBY_CODE = "ABC123";

function code() {
  return DEMO_LOBBY_CODE;
}

function lobbyPayload(lobby: LobbyState) {
  tickLobby(lobby, Date.now());
  return {
    code: lobby.code,
    phase: lobby.phase,
    durationMs: lobby.durationMs,
    startedAtMs: lobby.startedAtMs,
    endsAtMs: lobby.endsAtMs,
    maxSeats: lobby.maxSeats,
    mode: "freeplay" as const,
    arena: {
      id: lobby.arena.id,
      centerLat: lobby.arena.centerLat,
      centerLon: lobby.arena.centerLon,
      radiusM: lobby.arena.radiusM,
    },
    seats: [...lobby.seats.values()].map(seatPublicView),
    top3: topScores(lobby, 3).map(seatPublicView),
    rematchReady: [...lobby.rematchReady],
  };
}

async function maybeInitDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL not set — in-memory lobbies only");
    return null;
  }
  try {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: url });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lobbies (
        code TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        duration_ms INT NOT NULL,
        phase TEXT NOT NULL,
        results_json JSONB
      )
    `);
    console.log("Postgres ready");
    return pool;
  } catch (err) {
    console.warn("Postgres unavailable, continuing in-memory:", err);
    return null;
  }
}

async function main() {
  const db = await maybeInitDb();
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.get("/health", async () => ({
    ok: true,
    mode: "freeplay",
    arena: defaultArena.id,
    radiusM: defaultArena.radiusM,
    center: { lat: defaultArena.centerLat, lon: defaultArena.centerLon },
  }));

  app.post<{
    Body: {
      durationMs?: number;
      maxSeats?: number;
      radiusM?: number;
      centerLat?: number;
      centerLon?: number;
    };
  }>("/lobbies", async (req) => {
    const c = code();
    stopBotLoop(c);
    const maxSeats = Math.max(
      2,
      Math.min(8, Math.round(req.body?.maxSeats ?? 8)),
    );
    const radiusM = Math.max(
      50,
      Math.min(5000, Math.round(req.body?.radiusM ?? 500)),
    );
    const centerLat =
      typeof req.body?.centerLat === "number"
        ? req.body.centerLat
        : defaultArena.centerLat;
    const centerLon =
      typeof req.body?.centerLon === "number"
        ? req.body.centerLon
        : defaultArena.centerLon;
    const playArena = buildArena({ radiusM, centerLat, centerLon });
    const lobby = createLobby(c, playArena, {
      durationMs: req.body?.durationMs ?? 15 * 60 * 1000,
      maxSeats,
    });
    lobbies.set(c, lobby);
    if (db) {
      await db.query(
        `INSERT INTO lobbies(code, duration_ms, phase) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET duration_ms=$2, phase=$3`,
        [c, lobby.durationMs, lobby.phase],
      );
    }
    return {
      code: c,
      phase: lobby.phase,
      maxSeats: lobby.maxSeats,
      mode: "freeplay",
      arena: {
        id: playArena.id,
        centerLat: playArena.centerLat,
        centerLon: playArena.centerLon,
        radiusM: playArena.radiusM,
      },
    };
  });

  app.post<{
    Params: { code: string };
    Body: { nickname: string };
  }>("/lobbies/:code/join", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    try {
      const { seat } = joinLobby(lobby, req.body?.nickname ?? "Player");
      return { seat: seatPublicView(seat), phase: lobby.phase };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  app.post<{
    Params: { code: string };
    Body: { leaveHumanSlots?: number };
  }>("/lobbies/:code/bots/fill", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    if (lobby.phase !== "open") {
      return reply.code(400).send({ error: "lobby_not_open" });
    }
    const added = fillBots(lobby, req.body?.leaveHumanSlots ?? 1);
    return {
      added,
      seats: [...lobby.seats.values()].map(seatPublicView),
      phase: lobby.phase,
    };
  });

  app.post<{ Params: { code: string } }>(
    "/lobbies/:code/start",
    async (req, reply) => {
      const lobby = lobbies.get(req.params.code.toUpperCase());
      if (!lobby) return reply.code(404).send({ error: "not_found" });
      try {
        const effects = startLobby(lobby, Date.now());
        startBotLoop(lobby, 1000);
        if (db) {
          await db.query(`UPDATE lobbies SET phase=$2 WHERE code=$1`, [
            lobby.code,
            lobby.phase,
          ]);
        }
        return {
          phase: lobby.phase,
          endsAtMs: lobby.endsAtMs,
          effects,
          seats: [...lobby.seats.values()].map(seatPublicView),
        };
      } catch (e) {
        return reply.code(400).send({ error: String(e) });
      }
    },
  );

  app.post<{
    Params: { code: string };
    Body: { seatId: number; fix: Fix };
  }>("/lobbies/:code/fix", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    const now = Date.now();
    tickLobby(lobby, now);
    const effects = applyFix(lobby, req.body.seatId, req.body.fix, now);
    return {
      effects,
      seat: seatPublicView(lobby.seats.get(req.body.seatId)!),
      ...lobbyPayload(lobby),
    };
  });

  /** Seat taps Play again — waits for others / host rematch start. */
  app.post<{
    Params: { code: string };
    Body: { seatId: number };
  }>("/lobbies/:code/rematch/ready", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    try {
      // Bots auto-ready so human rematch isn't blocked in demo modes.
      for (const seat of lobby.seats.values()) {
        if (seatIsBot(seat)) lobby.rematchReady.add(seat.id);
      }
      const effects = markRematchReady(lobby, req.body.seatId);
      return { effects, ...lobbyPayload(lobby) };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  /** Host (or last ready seat when all humans ready) starts rematch. */
  app.post<{
    Params: { code: string };
    Body: { seatId: number };
  }>("/lobbies/:code/rematch/start", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    if (lobby.phase !== "ended") {
      return reply.code(400).send({ error: "bad_phase" });
    }
    const seatId = req.body.seatId;
    if (!lobby.seats.has(seatId)) {
      return reply.code(404).send({ error: "no_seat" });
    }
    try {
      for (const seat of lobby.seats.values()) {
        if (seatIsBot(seat)) lobby.rematchReady.add(seat.id);
      }
      if (!lobby.rematchReady.has(seatId)) {
        markRematchReady(lobby, seatId);
      }
      const humans = [...lobby.seats.values()].filter((s) => !seatIsBot(s));
      const humansReady = humans.every((s) => lobby.rematchReady.has(s.id));
      const isHost = seatId === Math.min(...lobby.seats.keys());
      if (!humansReady && !isHost) {
        return reply.code(400).send({ error: "waiting_for_players" });
      }
      stopBotLoop(lobby.code);
      const effects = startRematch(lobby, Date.now());
      startBotLoop(lobby, 1000);
      if (db) {
        await db.query(`UPDATE lobbies SET phase=$2 WHERE code=$1`, [
          lobby.code,
          lobby.phase,
        ]);
      }
      return { effects, ...lobbyPayload(lobby) };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  /** Auto-pilot one seat (join-bots / host-bots human automation). */
  app.post<{
    Params: { code: string };
    Body: { seatId: number; seed?: number };
  }>("/lobbies/:code/autopilot", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    const now = Date.now();
    tickBots(lobby, now);
    const rand = mulberry32((req.body.seed ?? 1) + req.body.seatId * 97 + now);
    const seat = lobby.seats.get(req.body.seatId);
    if (!seat) return reply.code(404).send({ error: "no_seat" });
    wanderSeat(lobby, seat.id, rand, now);
    return lobbyPayload(lobby);
  });

  app.get<{ Params: { code: string } }>(
    "/lobbies/:code",
    async (req, reply) => {
      const lobby = lobbies.get(req.params.code.toUpperCase());
      if (!lobby) return reply.code(404).send({ error: "not_found" });
      return lobbyPayload(lobby);
    },
  );

  app.addHook("onClose", async () => {
    for (const c of lobbies.keys()) stopBotLoop(c);
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`paper.irl server on :${port} mode=freeplay arena=${defaultArena.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
