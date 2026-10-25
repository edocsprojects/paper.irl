import {
  applyFix,
  buildKellerArena,
  clampToArena,
  createLobby,
  fromLocalM,
  joinLobby,
  pickNearestSafePoint,
  startLobby,
  tickLobby,
  toLocalM,
  topScores,
  type Arena,
  type Effect,
  type LatLon,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

export const YOU_ID = 1;
const BOTS = 8;
export const EVENT_MS = 7 * 24 * 60 * 60 * 1000;
const BOT_NAMES = ["Bobby", "Zack", "Maya", "Leo", "Priya", "Sam", "Ines"];
/** Demo grace after plant so P1 isn't wiped the same second they spawn. */
const YOU_PROTECT_MS = 25_000;

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimSnapshotSeat {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  lat: number;
  lon: number;
  trail: LatLon[];
  owned: LatLon[][];
  respawnAt: LatLon | null;
}

export interface SimSnapshot {
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
}

function seatLatLon(state: LobbyState, seat: Seat): LatLon {
  if (seat.position) return seat.position;
  if (seat.respawnAt) return seat.respawnAt;
  return {
    lat: state.arena.centerLat,
    lon: state.arena.centerLon,
  };
}

function youTrailPoints(state: LobbyState): LatLon[] {
  const you = state.seats.get(YOU_ID);
  if (!you || you.mode !== "trailing") return [];
  return you.trail;
}

function nearYouTrail(p: LatLon, youTrail: LatLon[], padM: number): boolean {
  if (youTrail.length < 2) return false;
  for (const t of youTrail) {
    const dx =
      (p.lon - t.lon) *
      111320 *
      Math.cos((p.lat * Math.PI) / 180);
    const dy = (p.lat - t.lat) * 111320;
    if (Math.hypot(dx, dy) < padM) return true;
  }
  return false;
}

const headings = new Map<number, number>();

function wanderStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  opts: { protectYou: boolean; homeBias: number },
): LatLon {
  const arena = state.arena;
  let pos =
    seat.position ??
    seat.respawnAt ??
    ({ lat: arena.centerLat, lon: arena.centerLon } as LatLon);

  if (seat.mode === "toPlant" && seat.respawnAt) {
    return { ...seat.respawnAt };
  }

  let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;
  const avoid = opts.protectYou ? youTrailPoints(state) : [];

  if (opts.protectYou && seat.id === YOU_ID && seat.mode === "safe" && seat.owned[0]) {
    // Stay near starter during protect
    const c = seat.owned[0][0]!;
    const local = toLocalM(c.lat, c.lon, pos.lat, pos.lon);
    if (Math.hypot(local.x, local.y) > 12) {
      heading = Math.atan2(-local.y, -local.x) + (rand() - 0.5) * 0.4;
    } else {
      heading += (rand() - 0.5) * 0.8;
    }
  } else if (seat.id !== YOU_ID && seat.mode === "safe" && rand() < 0.4) {
    const prey = [...state.seats.values()].find(
      (s) =>
        s.id !== seat.id &&
        !(opts.protectYou && s.id === YOU_ID) &&
        s.mode === "trailing" &&
        s.trail.length >= 2,
    );
    if (prey) {
      const tip = prey.trail[prey.trail.length - 1]!;
      const local = toLocalM(pos.lat, pos.lon, tip.lat, tip.lon);
      heading = Math.atan2(local.y, local.x);
    } else {
      heading += (rand() - 0.5) * 1.0;
    }
  } else if (seat.mode === "trailing" && rand() < opts.homeBias && seat.owned[0]) {
    const home = seat.owned[0][0]!;
    const local = toLocalM(pos.lat, pos.lon, home.lat, home.lon);
    heading = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.7;
  } else {
    heading += (rand() - 0.5) * 1.15;
  }

  // Realistic jog: one tick = one second, so 2.2–3.6 m per tick.
  const stepM = 2.2 + rand() * 1.4;
  let next = fromLocalM(
    pos.lat,
    pos.lon,
    Math.cos(heading) * stepM,
    Math.sin(heading) * stepM,
  );
  next = clampToArena(arena, next);

  if (opts.protectYou && seat.id !== YOU_ID && nearYouTrail(next, avoid, 18)) {
    heading += Math.PI * (0.5 + rand() * 0.5);
    next = clampToArena(
      arena,
      fromLocalM(pos.lat, pos.lon, Math.cos(heading) * stepM, Math.sin(heading) * stepM),
    );
  }

  const after = toLocalM(arena.centerLat, arena.centerLon, next.lat, next.lon);
  if (Math.hypot(after.x, after.y) > arena.radiusM * 0.96) {
    heading += Math.PI * (0.55 + rand() * 0.5);
  }
  headings.set(seat.id, heading);
  return next;
}

function botStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  now: number,
  opts: { protectYou: boolean },
): Effect[] {
  const homeBias = seat.id === YOU_ID ? 0.55 : 0.32;
  const pos = wanderStep(state, seat, rand, {
    protectYou: opts.protectYou,
    homeBias,
  });
  return applyFix(
    state,
    seat.id,
    {
      lat: pos.lat + (rand() - 0.5) * 0.000012,
      lon: pos.lon + (rand() - 0.5) * 0.000012,
      accuracyM: 5 + rand() * 4,
      speedMps: 1 + rand() * 2.5,
      clientTsMs: now,
      mock: true,
    },
    now,
  );
}

function youAwaitingSpawn(state: LobbyState): boolean {
  const you = state.seats.get(YOU_ID);
  if (!you) return false;
  return you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost";
}

export class CampusSim {
  state: LobbyState;
  private rand: () => number;
  private t0: number;
  nowMs: number;
  private seed: number;
  private youProtectUntilMs = 0;
  /** False after you tap End: your seat stays (land persists) but stops moving. */
  youActive = true;

  constructor(arena: Arena = buildKellerArena(), seed = 42) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    headings.clear();
    this.state = createLobby("DEMO", arena, {
      durationMs: EVENT_MS,
      maxSeats: BOTS,
    });
    joinLobby(this.state, "You");
    for (let i = 2; i <= BOTS; i++) {
      joinLobby(this.state, BOT_NAMES[i - 2] ?? `Bot${i}`);
    }
    this.t0 = Date.UTC(2026, 9, 24, 18, 0, 0);
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  restart() {
    const arena = this.state.arena;
    this.rand = mulberry32(this.seed + 1);
    this.seed += 1;
    this.youProtectUntilMs = 0;
    headings.clear();
    this.state = createLobby("DEMO", arena, {
      durationMs: EVENT_MS,
      maxSeats: BOTS,
    });
    joinLobby(this.state, "You");
    for (let i = 2; i <= BOTS; i++) {
      joinLobby(this.state, BOT_NAMES[i - 2] ?? `Bot${i}`);
    }
    startLobby(this.state, this.t0);
    this.nowMs = this.t0;
  }

  /** Player 1 taps Spawn → plant at a fresh safe marker. */
  spawnYou(): Effect[] {
    const you = this.state.seats.get(YOU_ID);
    if (!you || this.state.phase !== "live") return [];
    if (you.mode === "ghost") {
      you.mode = "toPlant";
      you.ghostUntilMs = null;
    }
    if (you.mode !== "toPlant" && you.mode !== "joining") return [];

    const from = you.respawnAt ?? you.position;
    you.respawnAt = pickNearestSafePoint(this.state, from, you.id * 17);
    const n = you.respawnAt;
    const effects = applyFix(
      this.state,
      YOU_ID,
      {
        lat: n.lat,
        lon: n.lon,
        accuracyM: 5,
        speedMps: 1,
        clientTsMs: this.nowMs,
        mock: true,
      },
      this.nowMs,
    );
    if (effects.some((e) => e.kind === "planted" && e.seatId === YOU_ID)) {
      this.youProtectUntilMs = this.nowMs + YOU_PROTECT_MS;
    }
    return effects;
  }

  /** Advance one simulated second. Returns game effects for snackbars. */
  tickOnce(): Effect[] {
    if (this.state.phase === "ended") return [];
    this.nowMs += 1000;
    const effects: Effect[] = [];
    const pauseYou = youAwaitingSpawn(this.state);
    const protectYou = this.nowMs < this.youProtectUntilMs;

    const others = [...this.state.seats.values()].filter((s) => s.id !== YOU_ID);
    const you = this.state.seats.get(YOU_ID);

    for (const seat of others) {
      effects.push(
        ...botStep(this.state, seat, this.rand, this.nowMs, { protectYou }),
      );
    }

    if (you && !pauseYou && this.youActive) {
      effects.push(
        ...botStep(this.state, you, this.rand, this.nowMs, { protectYou }),
      );
    }

    // Forced hunts among bots only (never P1)
    if (Math.floor((this.nowMs - this.t0) / 1000) % 7 === 0) {
      const prey = [...this.state.seats.values()].find(
        (s) =>
          s.id !== YOU_ID &&
          s.mode === "trailing" &&
          s.trail.length >= 2,
      );
      const hunter = [...this.state.seats.values()].find(
        (s) =>
          s.id !== YOU_ID &&
          s.mode === "safe" &&
          prey &&
          s.id !== prey.id,
      );
      if (prey && hunter) {
        const tip = prey.trail[Math.floor(prey.trail.length / 2)]!;
        effects.push(
          ...applyFix(
            this.state,
            hunter.id,
            {
              lat: tip.lat,
              lon: tip.lon,
              accuracyM: 5,
              speedMps: 2,
              clientTsMs: this.nowMs,
              mock: true,
            },
            this.nowMs,
          ),
        );
      }
    }

    effects.push(...tickLobby(this.state, this.nowMs));

    if (protectYou && you) {
      const cut = effects.find((e) => e.kind === "cut" && e.victimId === YOU_ID);
      if (cut && cut.kind === "cut" && you.mode === "toPlant") {
        const at =
          you.respawnAt ?? pickNearestSafePoint(this.state, null, YOU_ID);
        you.respawnAt = at;
        applyFix(
          this.state,
          YOU_ID,
          {
            lat: at.lat,
            lon: at.lon,
            accuracyM: 5,
            speedMps: 1,
            clientTsMs: this.nowMs,
            mock: true,
          },
          this.nowMs,
        );
        return effects.filter((e) => !(e.kind === "cut" && e.victimId === YOU_ID));
      }
    }
    return effects;
  }

  snapshot(): SimSnapshot {
    const ends = this.state.endsAtMs ?? this.nowMs;
    const seats: SimSnapshotSeat[] = [...this.state.seats.values()].map((seat) => {
      const { lat, lon } = seatLatLon(this.state, seat);
      return {
        id: seat.id,
        nickname: seat.nickname,
        mode: seat.mode,
        color: seat.color,
        areaM2: seat.areaM2,
        lat,
        lon,
        trail: seat.trail.map((p) => ({ ...p })),
        owned: seat.owned.map((ring) => ring.map((p) => ({ ...p }))),
        respawnAt: seat.respawnAt ? { ...seat.respawnAt } : null,
      };
    });
    const top3 = topScores(this.state, 3).map((s) => ({
      id: s.id,
      nickname: s.nickname,
      color: s.color,
      areaM2: s.areaM2,
    }));
    return {
      phase: this.state.phase,
      startedAtMs: this.state.startedAtMs ?? this.t0,
      endsAtMs: ends,
      nowMs: this.nowMs,
      remainingMs: Math.max(0, ends - this.nowMs),
      youNeedSpawn: youAwaitingSpawn(this.state) && this.state.phase === "live",
      seats,
      top3,
      you: seats.find((s) => s.id === YOU_ID) ?? null,
      arena: this.state.arena,
    };
  }
}
