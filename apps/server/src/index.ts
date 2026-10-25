import "./env.js";
import Fastify from "fastify";
import {
  applyFix,
  buildArena,
  buildKellerArena,
  createLobby,
  joinLobby,
  markRematchReady,
  mulberry32,
  resetBotMemory,
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
import { authConfigured, identify } from "./auth.js";
import { fillBots, startBotLoop, stopBotLoop } from "./bots.js";
import { EventManager } from "./event.js";

/**
 * Minimal HTTP API for local demos.
 * Live play state is in-memory. Postgres is optional (DATABASE_URL).
 * Freeplay MVP: GPS polylines inside Keller circle (no path-graph required).
 */
const defaultArena = buildKellerArena();
const lobbies = new Map<string, LobbyState>();

/** Random unused 6-character lobby code. */
function code() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 64; attempt++) {
    let s = "";
    for (let i = 0; i < 6; i++) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)]!;
    }
    if (!lobbies.has(s)) return s;
  }
  throw new Error("code_exhausted");
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
      starterRadiusM: lobby.arena.starterRadiusM,
    },
    serverNowMs: Date.now(),
    speedScale: lobby.speedScale,
    seats: [...lobby.seats.values()].map(seatPublicView),
    top3: topScores(lobby, 3).map(seatPublicView),
    rematchReady: [...lobby.rematchReady],
    notices: lobby.notices.map((n) => ({ ...n })),
    feed: lobby.feed.map((f) => ({ ...f, at: f.at ? { ...f.at } : null })),
    pops: lobby.pops.map((p) => ({ ...p, at: { ...p.at } })),
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
  const event = await EventManager.load(db);
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Guest-Id");
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
      /** Demo pace for bots/autopilot (1 = real jog, max 4). */
      speedScale?: number;
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
      speedScale: typeof req.body?.speedScale === "number" ? req.body.speedScale : 1,
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
        startBotLoop(lobby, 200);
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
    const seat = lobby.seats.get(Number(req.body?.seatId));
    if (!seat) return reply.code(404).send({ error: "no_seat" });
    if (!req.body?.fix || typeof req.body.fix !== "object") {
      return reply.code(400).send({ error: "bad_fix" });
    }
    const now = Date.now();
    const effects = tickLobby(lobby, now);
    effects.push(...applyFix(lobby, seat.id, req.body.fix, now));
    return {
      effects,
      seat: seatPublicView(seat),
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
      resetBotMemory(lobby.code);
      const effects = startRematch(lobby, Date.now());
      startBotLoop(lobby, 200);
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

  /**
   * Dev auto-pilot for the local human seat (no GPS, e.g. a simulator).
   * Client sends autoPlant:false until the player taps Spawn. Bots move on
   * their own server loop — never step them here (that double-sped them).
   */
  app.post<{
    Params: { code: string };
    Body: { seatId: number; seed?: number; autoPlant?: boolean };
  }>("/lobbies/:code/autopilot", async (req, reply) => {
    const lobby = lobbies.get(req.params.code.toUpperCase());
    if (!lobby) return reply.code(404).send({ error: "not_found" });
    const now = Date.now();
    const effects = tickLobby(lobby, now);
    const rand = mulberry32((req.body.seed ?? 1) + req.body.seatId * 97 + now);
    const seat = lobby.seats.get(req.body.seatId);
    if (!seat) return reply.code(404).send({ error: "no_seat" });
    const autoPlant = req.body.autoPlant !== false;
    effects.push(...wanderSeat(lobby, seat.id, rand, now, { autoPlant }));
    return { effects, ...lobbyPayload(lobby) };
  });

  app.get<{ Params: { code: string } }>(
    "/lobbies/:code",
    async (req, reply) => {
      const lobby = lobbies.get(req.params.code.toUpperCase());
      if (!lobby) return reply.code(404).send({ error: "not_found" });
      return lobbyPayload(lobby);
    },
  );

  /** Public 7-day event: live map state for everyone (seat id when identified). */
  app.get("/event", async (req) => {
    const who = await identify(req);
    return { ...event.payload(event.seatFor(who?.key ?? null)), authConfigured };
  });

  app.get("/event/results", async () => ({ results: event.recentResults() }));

  app.post<{ Body: { name?: string } }>("/event/join", async (req, reply) => {
    const who = await identify(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    try {
      const seatId = event.join(who.key, req.body?.name ?? "Player");
      return event.payload(seatId);
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  app.post<{ Body: { fix: Fix } }>("/event/fix", async (req, reply) => {
    const who = await identify(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const seatId = event.seatFor(who.key);
    if (seatId === null) return reply.code(409).send({ error: "not_joined" });
    const fix = req.body?.fix;
    if (!fix || typeof fix.lat !== "number" || typeof fix.lon !== "number") {
      return reply.code(400).send({ error: "bad_fix" });
    }
    const { outside, effects } = event.fix(seatId, fix);
    return { outside, effects, ...event.payload(seatId) };
  });

  app.addHook("onClose", async () => {
    for (const c of lobbies.keys()) stopBotLoop(c);
    await event.stop();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void app.close().then(() => process.exit(0)));
  }

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`paper.irl server on :${port} mode=freeplay arena=${defaultArena.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
