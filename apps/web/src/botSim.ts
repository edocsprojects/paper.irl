import {
  createLobby,
  joinLobby,
  mulberry32,
  resetBotMemory,
  startLobby,
  tickLobby,
  topScores,
  wanderSeat,
  type Arena,
  type DeathReason,
  type Effect,
  type LatLon,
  type LobbyState,
  type Seat,
  type Territory,
} from "@paper-irl/rules";

/** One player as the map + UI see it (same shape for simulation and live games). */
export interface SimSnapshotSeat {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  /** NaN when the player has no position yet. */
  lat: number;
  lon: number;
  trail: LatLon[];
  owned: Territory;
  respawnAt: LatLon | null;
  bot: boolean;
}

export interface FeedEvent {
  atMs: number;
  victimId: number;
  byId: number;
  reason: DeathReason;
  at: LatLon | null;
}

export interface NoticeEvent {
  atMs: number;
  seatId: number;
  byId: number;
  lostM2: number;
}

export interface SimSnapshot {
  code: string;
  phase: string;
  startedAtMs: number;
  endsAtMs: number;
  nowMs: number;
  remainingMs: number;
  youNeedSpawn: boolean;
  seats: SimSnapshotSeat[];
  top3: { id: number; nickname: string; color: string; areaM2: number }[];
  you: SimSnapshotSeat | null;
  arena: Arena;
  feed: FeedEvent[];
  notices: NoticeEvent[];
  pops: { atMs: number; seatId: number; at: LatLon }[];
}

/** Simulated time per step: bots and autopilot move at 5 Hz like the server. */
const STEP_MS = 200;
/** Cap on catch-up work per animation frame (20× at 60 fps fits easily). */
const MAX_STEPS_PER_FRAME = 40;

export function seatToView(seat: Seat): SimSnapshotSeat {
  const at = seat.position ?? seat.respawnAt;
  return {
    id: seat.id,
    nickname: seat.nickname,
    mode: seat.mode,
    color: seat.color,
    areaM2: seat.areaM2,
    lat: at?.lat ?? NaN,
    lon: at?.lon ?? NaN,
    trail: seat.trail.map((p) => ({ ...p })),
    owned: seat.owned.map((poly) => poly.map((ring) => ring.map((p) => ({ ...p })))),
    respawnAt: seat.respawnAt ? { ...seat.respawnAt } : null,
    bot: seat.bot,
  };
}

export type LocalMatchOpts = {
  arena: Arena;
  /** Your seat; omit for a bots-only "attract mode" match (Home background). */
  youName?: string;
  players: number;
  durationMs: number;
  seed?: number;
  /** False: start with just you; players arrive via addPlayer() (lobby). */
  fill?: boolean;
};

/**
 * A whole match running in the browser on the real rules package: bots (and
 * you, on autopilot) walk at jogging pace; `speed` fast-forwards time.
 */
export class LocalMatch {
  readonly state: LobbyState;
  readonly youId: number | null;
  nowMs: number;
  /** False after you leave: your seat keeps its land but stops moving. */
  youActive = true;
  private rand: () => number;
  private acc = 0;

  constructor(opts: LocalMatchOpts) {
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    this.rand = mulberry32(seed);
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = Array.from({ length: 6 }, () => letters[Math.floor(this.rand() * letters.length)]).join("");
    resetBotMemory(code);
    this.state = createLobby(code, opts.arena, {
      durationMs: opts.durationMs,
      maxSeats: Math.max(2, Math.min(8, opts.players)),
    });
    this.youId = opts.youName !== undefined ? joinLobby(this.state, opts.youName).seat.id : null;
    if (opts.fill !== false) while (this.addPlayer());
    this.nowMs = Date.now();
  }

  /** Another player joins the lobby; false when it's full or already started. */
  addPlayer(): boolean {
    if (this.state.phase !== "open" || this.state.seats.size >= this.state.maxSeats) return false;
    joinLobby(this.state, `Player ${this.state.nextSeatId}`, { bot: true });
    return true;
  }

  /** Lobby → live (everyone spawns on their own ring slot). */
  start() {
    if (this.state.phase !== "open") return;
    this.nowMs = Date.now();
    startLobby(this.state, this.nowMs);
  }

  get ended() {
    return this.state.phase === "ended";
  }

  /** Advance by `dtRealS` real seconds at `speed`×. Returns your effects. */
  advance(dtRealS: number, speed: number): Effect[] {
    if (this.state.phase !== "live") return [];
    this.acc += dtRealS * 1000 * speed;
    const out: Effect[] = [];
    let steps = 0;
    while (this.acc >= STEP_MS && steps < MAX_STEPS_PER_FRAME && !this.ended) {
      this.acc -= STEP_MS;
      steps++;
      this.nowMs += STEP_MS;
      out.push(...tickLobby(this.state, this.nowMs));
      for (const seat of this.state.seats.values()) {
        if (seat.id === this.youId && !this.youActive) continue;
        out.push(...wanderSeat(this.state, seat.id, this.rand, this.nowMs));
      }
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = 0; // never spiral after a stall
    return out;
  }

  snapshot(): SimSnapshot {
    const s = this.state;
    const ends = s.endsAtMs ?? this.nowMs;
    const seats = [...s.seats.values()].map(seatToView);
    const you = seats.find((x) => x.id === this.youId) ?? null;
    return {
      code: s.code,
      phase: s.phase,
      startedAtMs: s.startedAtMs ?? this.nowMs,
      endsAtMs: ends,
      nowMs: this.nowMs,
      remainingMs: Math.max(0, ends - this.nowMs),
      youNeedSpawn: !!you && ["joining", "toPlant", "ghost"].includes(you.mode),
      seats,
      top3: topScores(s, 3).map(({ id, nickname, color, areaM2 }) => ({ id, nickname, color, areaM2 })),
      you,
      arena: s.arena,
      feed: s.feed.map((f) => ({ ...f })),
      notices: s.notices.map(({ atMs, seatId, byId, lostM2 }) => ({ atMs, seatId, byId, lostM2 })),
      pops: s.pops.map((p) => ({ ...p })),
    };
  }
}
