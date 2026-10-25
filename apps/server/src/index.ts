import Fastify from "fastify";
import {
  applyFix,
  buildKellerArena,
  createLobby,
  joinLobby,
  seatPublicView,
  startLobby,
  tickLobby,
  topScores,
  type Fix,
  type LobbyState,
} from "@paper-irl/rules";

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
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
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

  app.post<{ Params: { code: string } }>(
    "/lobbies/:code/start",
    async (req, reply) => {
      const lobby = lobbies.get(req.params.code.toUpperCase());
      if (!lobby) return reply.code(404).send({ error: "not_found" });
      try {
        const effects = startLobby(lobby, Date.now());
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
      phase: lobby.phase,
      effects,
      seat: seatPublicView(lobby.seats.get(req.body.seatId)!),
    };
  });

  app.get<{ Params: { code: string } }>(
    "/lobbies/:code",
    async (req, reply) => {
      const lobby = lobbies.get(req.params.code.toUpperCase());
      if (!lobby) return reply.code(404).send({ error: "not_found" });
      tickLobby(lobby, Date.now());
      return {
        code: lobby.code,
        phase: lobby.phase,
        endsAtMs: lobby.endsAtMs,
        mode: "freeplay",
        seats: [...lobby.seats.values()].map(seatPublicView),
        top3: topScores(lobby, 3).map(seatPublicView),
      };
    },
  );

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
