import Fastify from "fastify";
import {
  applyFix,
  buildKellerArena,
  createLobby,
  joinLobby,
  mulberry32,
  seatPublicView,
  startLobby,
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
const arena = buildKellerArena();
const lobbies = new Map<string, LobbyState>();

function code() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "KELL-";
  for (let i = 0; i < 4; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return s;
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
    arena: arena.id,
    radiusM: arena.radiusM,
    center: { lat: arena.centerLat, lon: arena.centerLon },
  }));

  app.post<{
    Body: { durationMs?: number };
  }>("/lobbies", async (req) => {
    const c = code();
    const lobby = createLobby(c, arena, {
      durationMs: req.body?.durationMs ?? 15 * 60 * 1000,
    });
    lobbies.set(c, lobby);
    if (db) {
      await db.query(
        `INSERT INTO lobbies(code, duration_ms, phase) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO NOTHING`,
        [c, lobby.durationMs, lobby.phase],
      );
    }
    return { code: c, phase: lobby.phase, maxSeats: lobby.maxSeats, mode: "freeplay" };
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
  console.log(`paper.irl server on :${port} mode=freeplay arena=${arena.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
