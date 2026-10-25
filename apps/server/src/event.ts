import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  applyFix,
  buildArena,
  createLobby,
  isInsideArena,
  joinLobby,
  seatPublicView,
  tickLobby,
  topScores,
  type Fix,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

/**
 * Public community events. Each one runs on its own circle for a fixed
 * window (default 1 hour); anyone can join at any time. When it ends the top
 * seat is recorded as the winner and a fresh round starts. State is persisted
 * (Postgres when DATABASE_URL is set, else data/event/<id>-*.json).
 */
export const EVENT_DURATION_MS = Number(process.env.EVENT_DURATION_MS ?? 60 * 60 * 1000);

export interface EventConfig {
  id: string;
  name: string;
  place: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  durationMs: number;
}

/** The community events on offer (ids are used in /events/:id). */
export const EVENTS: EventConfig[] = [
  {
    id: "keller",
    name: "Keller Hall · UMN",
    place: "200 Union St SE, Minneapolis",
    centerLat: 44.97452,
    centerLon: -93.23256,
    radiusM: 500,
    durationMs: EVENT_DURATION_MS,
  },
  {
    id: "north-loop",
    name: "North Loop",
    place: "300 Washington Ave N, Minneapolis",
    centerLat: 44.98495,
    centerLon: -93.27252,
    radiusM: 500,
    durationMs: EVENT_DURATION_MS,
  },
  {
    id: "chicago",
    name: "Millennium Park · Chicago",
    place: "201 E Randolph St, Chicago",
    centerLat: 41.88255,
    centerLon: -87.62255,
    radiusM: 500,
    durationMs: EVENT_DURATION_MS,
  },
];
const EVENT_MAX_SEATS = 500;
const TICK_MS = 5_000;
const SAVE_MS = 15_000;

const DATA_DIR =
  process.env.EVENT_DATA_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/event");

export interface EventResult {
  code: string;
  startedAtMs: number;
  endedAtMs: number;
  winner: { name: string; areaM2: number; color: string } | null;
  top: { name: string; areaM2: number; color: string }[];
}

interface Player {
  seatId: number;
  name: string;
}

interface StoredEvent {
  lobby: Omit<LobbyState, "seats" | "rematchReady"> & {
    seats: Seat[];
    rematchReady: number[];
  };
  players: Record<string, Player>;
}

function serialize(lobby: LobbyState, players: Map<string, Player>): StoredEvent {
  return {
    lobby: {
      ...lobby,
      seats: [...lobby.seats.values()],
      rematchReady: [...lobby.rematchReady],
    },
    players: Object.fromEntries(players),
  };
}

function deserialize(s: StoredEvent): { lobby: LobbyState; players: Map<string, Player> } {
  return {
    lobby: {
      ...s.lobby,
      seats: new Map(s.lobby.seats.map((seat) => [seat.id, seat])),
      rematchReady: new Set(s.lobby.rematchReady),
    },
    players: new Map(Object.entries(s.players)),
  };
}

function newEventLobby(cfg: EventConfig, now: number): LobbyState {
  const code = `${cfg.id}-${new Date(now).toISOString().slice(0, 16)}`;
  const arena = buildArena({ radiusM: cfg.radiusM, centerLat: cfg.centerLat, centerLon: cfg.centerLon });
  const lobby = createLobby(code, arena, {
    durationMs: cfg.durationMs,
    maxSeats: EVENT_MAX_SEATS,
  });
  // Events open live with zero seats; players late-join.
  lobby.phase = "live";
  lobby.startedAtMs = now;
  lobby.endsAtMs = now + cfg.durationMs;
  return lobby;
}

export class EventManager {
  lobby: LobbyState;
  private players = new Map<string, Player>();
  private results: EventResult[] = [];
  private dirty = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  private constructor(
    readonly config: EventConfig,
    private db: pg.Pool | null,
  ) {
    this.lobby = newEventLobby(config, Date.now());
  }

  static async load(config: EventConfig, db: pg.Pool | null): Promise<EventManager> {
    const mgr = new EventManager(config, db);
    await mgr.restore();
    mgr.tick();
    mgr.timers.push(setInterval(() => mgr.tick(), TICK_MS));
    mgr.timers.push(setInterval(() => void mgr.save(), SAVE_MS));
    return mgr;
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    await this.save();
  }

  /** Join (or rename) the current event. Returns the player's seat id. */
  join(playerKey: string, name: string): number {
    const clean = name.trim().slice(0, 20) || "Player";
    const existing = this.players.get(playerKey);
    const seat = existing && this.lobby.seats.get(existing.seatId);
    if (existing && seat) {
      if (existing.name !== clean) {
        const taken = new Set(
          [...this.lobby.seats.values()].filter((s) => s.id !== seat.id).map((s) => s.nickname),
        );
        let unique = clean;
        for (let i = 2; taken.has(unique); i++) unique = `${clean}${i}`;
        seat.nickname = unique;
        existing.name = clean;
        this.dirty = true;
      }
      return seat.id;
    }
    const { seat: added } = joinLobby(this.lobby, clean, { allowLive: true });
    this.players.set(playerKey, { seatId: added.id, name: clean });
    this.dirty = true;
    return added.id;
  }

  seatFor(playerKey: string | null): number | null {
    if (!playerKey) return null;
    const p = this.players.get(playerKey);
    return p && this.lobby.seats.has(p.seatId) ? p.seatId : null;
  }

  /** Fixes outside the circle are not applied: they never count toward rank. */
  fix(seatId: number, fix: Fix) {
    const now = Date.now();
    this.tick(now);
    const inside = isInsideArena(this.lobby.arena, fix);
    if (!inside) return { outside: true, effects: [] };
    const effects = applyFix(this.lobby, seatId, { ...fix, plant: undefined }, now);
    this.dirty = true;
    return { outside: false, effects };
  }

  /** Card info for the events list. */
  summary() {
    const lobby = this.lobby;
    return {
      id: this.config.id,
      name: this.config.name,
      place: this.config.place,
      durationMs: this.config.durationMs,
      endsAtMs: lobby.endsAtMs,
      nowMs: Date.now(),
      players: lobby.seats.size,
      arena: {
        centerLat: lobby.arena.centerLat,
        centerLon: lobby.arena.centerLon,
        radiusM: lobby.arena.radiusM,
      },
    };
  }

  payload(yourSeatId: number | null) {
    const lobby = this.lobby;
    return {
      eventId: this.config.id,
      eventName: this.config.name,
      code: lobby.code,
      phase: lobby.phase,
      startedAtMs: lobby.startedAtMs,
      endsAtMs: lobby.endsAtMs,
      nowMs: Date.now(),
      arena: {
        id: lobby.arena.id,
        centerLat: lobby.arena.centerLat,
        centerLon: lobby.arena.centerLon,
        radiusM: lobby.arena.radiusM,
      },
      seats: [...lobby.seats.values()].map(seatPublicView),
      yourSeatId,
      lastResult: this.results[0] ?? null,
    };
  }

  recentResults(n = 10) {
    return this.results.slice(0, n);
  }

  private tick(now = Date.now()) {
    tickLobby(this.lobby, now);
    if (this.lobby.phase === "ended") void this.rollOver(now);
  }

  private async rollOver(now: number) {
    const lobby = this.lobby;
    const top = topScores(lobby, 3)
      .filter((s) => s.areaM2 > 0)
      .map((s) => ({ name: s.nickname, areaM2: Math.round(s.areaM2), color: s.color }));
    const result: EventResult = {
      code: lobby.code,
      startedAtMs: lobby.startedAtMs ?? now,
      endedAtMs: lobby.endsAtMs ?? now,
      winner: top[0] ?? null,
      top,
    };
    this.results.unshift(result);
    this.lobby = newEventLobby(this.config, now);
    this.players.clear();
    this.dirty = true;
    console.log(
      `Event ${result.code} ended — winner: ${result.winner?.name ?? "nobody"}; started ${this.lobby.code}`,
    );
    if (this.db) {
      await this.db.query(
        `INSERT INTO event_results(code, started_at, ended_at, winner_name, winner_area, top_json, event_id)
         VALUES ($1, to_timestamp($2/1000.0), to_timestamp($3/1000.0), $4, $5, $6, $7)`,
        [
          result.code,
          result.startedAtMs,
          result.endedAtMs,
          result.winner?.name ?? null,
          result.winner?.areaM2 ?? null,
          JSON.stringify(result.top),
          this.config.id,
        ],
      );
    }
    await this.save();
  }

  private async restore() {
    try {
      if (this.db) {
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS event_state (
            id TEXT PRIMARY KEY,
            state_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT now()
          );
          CREATE TABLE IF NOT EXISTS event_results (
            id SERIAL PRIMARY KEY,
            code TEXT NOT NULL,
            started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ,
            winner_name TEXT,
            winner_area REAL,
            top_json JSONB
          );
        `);
        await this.db.query(`ALTER TABLE event_results ADD COLUMN IF NOT EXISTS event_id TEXT`);
        const state = await this.db.query(`SELECT state_json FROM event_state WHERE id=$1`, [this.config.id]);
        if (state.rows[0]) this.adopt(state.rows[0].state_json as StoredEvent);
        const res = await this.db.query(
          `SELECT code, started_at, ended_at, top_json FROM event_results WHERE event_id=$1 ORDER BY ended_at DESC LIMIT 10`,
          [this.config.id],
        );
        this.results = res.rows.map((r) => {
          const top = (r.top_json ?? []) as EventResult["top"];
          return {
            code: r.code,
            startedAtMs: new Date(r.started_at).getTime(),
            endedAtMs: new Date(r.ended_at).getTime(),
            winner: top[0] ?? null,
            top,
          };
        });
      } else {
        const raw = await readFile(this.file("state"), "utf8").catch(() => null);
        if (raw) this.adopt(JSON.parse(raw) as StoredEvent);
        const res = await readFile(this.file("results"), "utf8").catch(() => null);
        if (res) this.results = JSON.parse(res) as EventResult[];
      }
      console.log(`Event ${this.lobby.code}: ${this.lobby.seats.size} players, ends ${new Date(this.lobby.endsAtMs!).toISOString()}`);
      // A saved round from an older (longer) schedule or a moved circle: start a fresh round now.
      const a = this.lobby.arena;
      const moved =
        Math.abs(a.centerLat - this.config.centerLat) > 1e-6 ||
        Math.abs(a.centerLon - this.config.centerLon) > 1e-6 ||
        a.radiusM !== this.config.radiusM;
      if (moved || (this.lobby.endsAtMs ?? 0) - Date.now() > this.config.durationMs) {
        this.lobby = newEventLobby(this.config, Date.now());
        this.players.clear();
        this.dirty = true;
      }
    } catch (err) {
      console.warn("Event restore failed, starting fresh:", err);
    }
  }

  private file(kind: "state" | "results") {
    return path.join(DATA_DIR, `${this.config.id}-${kind}.json`);
  }

  private adopt(stored: StoredEvent) {
    const { lobby, players } = deserialize(stored);
    this.lobby = lobby;
    this.players = players;
  }

  private async save() {
    if (!this.dirty) return;
    this.dirty = false;
    const stored = serialize(this.lobby, this.players);
    try {
      if (this.db) {
        await this.db.query(
          `INSERT INTO event_state(id, state_json, updated_at) VALUES ($2, $1, now())
           ON CONFLICT (id) DO UPDATE SET state_json=$1, updated_at=now()`,
          [JSON.stringify(stored), this.config.id],
        );
      } else {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(this.file("state"), JSON.stringify(stored));
        await writeFile(this.file("results"), JSON.stringify(this.results));
      }
    } catch (err) {
      this.dirty = true;
      console.warn("Event save failed:", err);
    }
  }
}
