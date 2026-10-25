import { haversineM, type Arena, type Effect, type LatLon, type Territory } from "@paper-irl/rules";
import type { FeedEvent, NoticeEvent, SimSnapshot, SimSnapshotSeat } from "./botSim.js";

/** Same-origin API (Vite proxies /api → the game server). */
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const POLL_MS = 500;

interface PublicSeat {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  trail: LatLon[];
  owned: Territory;
  position: LatLon | null;
  respawnAt: LatLon | null;
  bot?: boolean;
}

export interface LobbyPayload {
  code: string;
  phase: "open" | "live" | "ended" | string;
  durationMs: number;
  startedAtMs: number | null;
  endsAtMs: number | null;
  maxSeats: number;
  arena: { id: string; centerLat: number; centerLon: number; radiusM: number; starterRadiusM?: number };
  serverNowMs?: number;
  seats: PublicSeat[];
  feed?: FeedEvent[];
  rematchReady?: number[];
  notices?: (NoticeEvent & { kind?: string })[];
  pops?: { atMs: number; seatId: number; at: LatLon }[];
}

export type GpsStatus =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "denied" }
  | { kind: "error"; message: string }
  | { kind: "ok"; accuracyM: number };

export type CreateOpts = {
  name: string;
  center: LatLon;
  radiusM: number;
  maxSeats: number;
  fillBots: boolean;
  durationMs?: number;
};

/**
 * A server-hosted Create/Join lobby played with real GPS: waiting room
 * polling, host Start, and one-at-a-time fixes while running.
 */
export class LiveMatch {
  payload: LobbyPayload | null = null;
  code: string | null = null;
  seatId: number | null = null;
  isHost = false;
  serverError: string | null = null;
  gps: GpsStatus = { kind: "idle" };
  /** Latest raw GPS position (may be outside the circle). */
  raw: LatLon | null = null;
  outside = false;
  outsideTracks: LatLon[][] = [];
  tracking = false;
  paused = false;
  /** Tapped "Spawn": fixes may plant your base (respawns are then automatic). */
  armed = false;
  /** Bumps on every new payload so the UI knows to repaint. */
  version = 0;

  private receivedAt = 0;
  private watchId: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private pendingFix: GeolocationPosition | null = null;
  private lastInside: LatLon | null = null;
  private lastSample: { p: LatLon; t: number } | null = null;

  /** "lobby" = Create/Join games; "event" = the public Keller Hall event. */
  kind: "lobby" | "event" = "lobby";
  /** Event extras (winner of the last event). */
  lastWinner: { name: string; areaM2: number } | null = null;

  constructor(
    private onEffects: (effects: Effect[]) => void,
    private identity: () => Record<string, string> = () => ({}),
  ) {}

  /** Watch / play the public event (identified by guest id or Google token). */
  /** Which community event (for /events/:id). */
  eventId = "keller";

  async openEvent(id: string) {
    this.leave();
    this.kind = "event";
    this.eventId = id;
    this.code = "EVENT";
    await this.refresh();
    this.startPolling();
  }

  async joinEvent(name: string) {
    this.kind = "event";
    this.accept(await this.request("POST", `/events/${this.eventId}/join`, { name }));
    this.armed = true; // event plants as soon as you're inside the circle
  }

  get arena(): Arena | null {
    const a = this.payload?.arena;
    if (!a) return null;
    return {
      id: a.id,
      centerLat: a.centerLat,
      centerLon: a.centerLon,
      radiusM: a.radiusM,
      pathWidthM: 5,
      starterRadiusM: a.starterRadiusM ?? 22,
    };
  }

  async create(opts: CreateOpts) {
    const created = (await this.request("POST", "/lobbies", {
      centerLat: opts.center.lat,
      centerLon: opts.center.lon,
      radiusM: Math.round(opts.radiusM),
      maxSeats: opts.maxSeats,
      durationMs: opts.durationMs,
    })) as { code: string };
    await this.join(created.code, opts.name);
    this.isHost = true;
    if (opts.fillBots) await this.request("POST", `/lobbies/${created.code}/bots/fill`, { leaveHumanSlots: 1 });
    await this.refresh();
  }

  async join(code: string, name: string) {
    const c = code.trim().toUpperCase();
    const res = (await this.request("POST", `/lobbies/${c}/join`, { nickname: name })) as {
      seat: { id: number };
    };
    this.code = c;
    this.seatId = res.seat.id;
    this.isHost = false;
    await this.refresh();
    this.startPolling();
  }

  async start() {
    if (!this.code) return;
    await this.request("POST", `/lobbies/${this.code}/start`, {});
    await this.refresh();
  }

  /** Play again with the same lobby: mark ready; the host starts the rematch. */
  async playAgain() {
    if (!this.code || this.seatId === null) return;
    await this.request("POST", `/lobbies/${this.code}/rematch/ready`, { seatId: this.seatId });
    if (this.isHost) await this.request("POST", `/lobbies/${this.code}/rematch/start`, { seatId: this.seatId });
    this.armed = false;
    await this.refresh();
  }

  /** Send the latest GPS fix right now (e.g. right after tapping Spawn). */
  nudge() {
    if (this.raw && !this.pendingFix && !this.sending) {
      const p = this.raw;
      void this.request("POST", `/lobbies/${this.code}/fix`, {
        seatId: this.seatId,
        fix: { lat: p.lat, lon: p.lon, accuracyM: 8, speedMps: 0, clientTsMs: Date.now(), plant: this.armed ? undefined : false },
      })
        .then((res) => {
          this.accept(res);
          const effects = (res as { effects?: Effect[] }).effects ?? [];
          if (effects.length) this.onEffects(effects);
        })
        .catch((err) => this.fail(err));
    }
  }

  leave() {
    this.stopTracking();
    this.stopPolling();
    this.payload = null;
    this.code = null;
    this.seatId = null;
    this.isHost = false;
    this.kind = "lobby";
    this.lastWinner = null;
    this.version++;
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      // Fix responses already carry fresh state while GPS is streaming.
      if (!this.tracking || this.paused || this.outside) void this.refresh();
    }, POLL_MS);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async refresh() {
    if (!this.code) return;
    try {
      this.accept(await this.request("GET", this.kind === "event" ? `/events/${this.eventId}` : `/lobbies/${this.code}`));
    } catch (err) {
      this.fail(err);
    }
  }

  /** Tell the server where you stand before Start so you spawn right there. */
  async sendHere(p: LatLon) {
    if (!this.code || this.seatId === null) return;
    await this.request("POST", `/lobbies/${this.code}/fix`, {
      seatId: this.seatId,
      fix: { lat: p.lat, lon: p.lon, accuracyM: 10, speedMps: 0, clientTsMs: Date.now(), plant: false },
    }).catch(() => undefined);
  }

  startTracking() {
    if (!navigator.geolocation) {
      this.gps = { kind: "error", message: "This browser has no GPS access." };
      return;
    }
    if (this.watchId !== null) return;
    this.tracking = true;
    this.paused = false;
    this.gps = { kind: "waiting" };
    this.outsideTracks = [];
    this.outside = false;
    this.lastInside = null;
    this.lastSample = null;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onPosition(pos),
      (err) => {
        this.gps =
          err.code === err.PERMISSION_DENIED
            ? { kind: "denied" }
            : { kind: "error", message: err.message || "GPS unavailable" };
        this.version++;
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  stopTracking() {
    this.tracking = false;
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.gps = { kind: "idle" };
  }

  serverNow(): number {
    const p = this.payload;
    return (p?.serverNowMs ?? Date.now()) + (Date.now() - this.receivedAt);
  }

  /** Map/UI view in the same shape as the simulation. */
  snapshot(): SimSnapshot | null {
    const p = this.payload;
    const arena = this.arena;
    if (!p || !arena) return null;
    const now = this.serverNow();
    const seats: SimSnapshotSeat[] = p.seats.map((s) => {
      const at = s.position ?? s.respawnAt;
      const mine = s.id === this.seatId;
      const shown = mine && this.tracking && this.raw ? this.raw : at;
      return {
        id: s.id,
        nickname: s.nickname,
        mode: s.mode,
        color: s.color,
        areaM2: s.areaM2,
        lat: shown?.lat ?? NaN,
        lon: shown?.lon ?? NaN,
        trail: s.trail,
        owned: s.owned,
        respawnAt: s.respawnAt,
        bot: !!s.bot,
      };
    });
    const top3 = [...seats]
      .sort((a, b) => b.areaM2 - a.areaM2)
      .slice(0, 3)
      .map(({ id, nickname, color, areaM2 }) => ({ id, nickname, color, areaM2 }));
    const you = seats.find((s) => s.id === this.seatId) ?? null;
    const endsAt = p.endsAtMs ?? now + p.durationMs;
    return {
      code: p.code,
      phase: p.phase,
      startedAtMs: p.startedAtMs ?? now,
      endsAtMs: endsAt,
      nowMs: now,
      remainingMs: p.phase === "live" ? Math.max(0, endsAt - now) : p.durationMs,
      youNeedSpawn: !!you && ["joining", "toPlant", "ghost"].includes(you.mode),
      seats,
      top3,
      you,
      arena,
      feed: p.feed ?? [],
      notices: (p.notices ?? []).map(({ atMs, seatId, byId, lostM2 }) => ({ atMs, seatId, byId, lostM2 })),
      pops: p.pops ?? [],
    };
  }

  private onPosition(pos: GeolocationPosition) {
    const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    this.raw = p;
    this.gps = { kind: "ok", accuracyM: pos.coords.accuracy };
    this.version++;
    if (this.paused) return;
    const arena = this.arena;
    const inside = !arena || haversineM(p.lat, p.lon, arena.centerLat, arena.centerLon) <= arena.radiusM;
    if (!inside) {
      // Shown on the map only — never sent, so it can't count toward rank.
      if (!this.outside) this.outsideTracks.push(this.lastInside ? [this.lastInside, p] : [p]);
      else this.outsideTracks[this.outsideTracks.length - 1]!.push(p);
      this.outside = true;
      return;
    }
    if (this.outside) this.outsideTracks[this.outsideTracks.length - 1]!.push(p);
    this.outside = false;
    this.lastInside = p;
    this.pendingFix = pos;
    void this.flush();
  }

  /** One fix in flight at a time; newer positions replace queued ones. */
  private async flush() {
    if (this.sending || !this.pendingFix || !this.code || this.seatId === null) return;
    const pos = this.pendingFix;
    this.pendingFix = null;
    this.sending = true;
    const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    let speed = pos.coords.speed;
    if (speed === null && this.lastSample) {
      const dt = (pos.timestamp - this.lastSample.t) / 1000;
      speed = dt > 0 ? haversineM(p.lat, p.lon, this.lastSample.p.lat, this.lastSample.p.lon) / dt : 0;
    }
    this.lastSample = { p, t: pos.timestamp };
    try {
      const path = this.kind === "event" ? `/events/${this.eventId}/fix` : `/lobbies/${this.code}/fix`;
      const res = await this.request("POST", path, {
        seatId: this.seatId,
        fix: {
          lat: p.lat,
          lon: p.lon,
          accuracyM: pos.coords.accuracy,
          speedMps: speed ?? 0,
          clientTsMs: pos.timestamp,
          plant: this.armed ? undefined : false,
        },
      });
      this.accept(res);
      const effects = (res as { effects?: Effect[] }).effects ?? [];
      if (effects.length) this.onEffects(effects);
    } catch (err) {
      this.fail(err);
    } finally {
      this.sending = false;
      if (this.pendingFix) void this.flush();
    }
  }

  private accept(payload: unknown) {
    if (this.kind === "event") {
      // Event payload: { nowMs, yourSeatId, lastResult, ... } → lobby shape.
      const e = payload as LobbyPayload & {
        nowMs?: number;
        yourSeatId?: number | null;
        lastResult?: { winner: { name: string; areaM2: number } | null } | null;
      };
      e.serverNowMs = e.nowMs;
      e.durationMs = (e.endsAtMs ?? 0) - (e.startedAtMs ?? 0);
      e.maxSeats = 500;
      if (e.yourSeatId != null) this.seatId = e.yourSeatId;
      this.lastWinner = e.lastResult?.winner ?? null;
    }
    this.payload = payload as LobbyPayload;
    this.receivedAt = Date.now();
    this.serverError = null;
    this.version++;
  }

  private fail(err: unknown) {
    this.serverError = err instanceof Error ? err.message : String(err);
    this.version++;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...this.identity() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Can't reach the game server");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status >= 502) throw new Error("Can't reach the game server");
      if (res.status === 404) throw new Error("No game with that code");
      const msg = String(data.error ?? `Server error ${res.status}`);
      if (msg.includes("lobby_full")) throw new Error("That game is full");
      if (msg.includes("lobby_not_open")) throw new Error("That game already started");
      throw new Error(msg);
    }
    return data;
  }
}
