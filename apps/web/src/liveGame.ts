import { buildKellerArena, haversineM, type Effect, type LatLon } from "@paper-irl/rules";
import type { SimSnapshot, SimSnapshotSeat } from "./botSim.js";

/** Same-origin API (Vite proxies /api → the game server). */
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const POLL_MS = 2500;
const arena = buildKellerArena();

interface PublicSeat {
  id: number;
  nickname: string;
  mode: string;
  color: string;
  areaM2: number;
  trail: LatLon[];
  owned: LatLon[][];
  position: LatLon | null;
  respawnAt: LatLon | null;
}

export interface EventResult {
  code: string;
  endedAtMs: number;
  winner: { name: string; areaM2: number; color: string } | null;
}

export interface EventPayload {
  code: string;
  phase: string;
  startedAtMs: number;
  endsAtMs: number;
  nowMs: number;
  seats: PublicSeat[];
  yourSeatId: number | null;
  lastResult: EventResult | null;
  authConfigured?: boolean;
}

export type GpsStatus =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "denied" }
  | { kind: "error"; message: string }
  | { kind: "ok"; accuracyM: number };

export class LiveGame {
  payload: EventPayload | null = null;
  serverError: string | null = null;
  gps: GpsStatus = { kind: "idle" };
  /** Latest raw GPS position (may be outside the circle). */
  raw: LatLon | null = null;
  outside = false;
  outsideTracks: LatLon[][] = [];
  tracking = false;
  paused = false;
  /** Bumps on every new payload so the UI knows to repaint. */
  version = 0;

  private receivedAt = 0;
  private watchId: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private pendingFix: GeolocationPosition | null = null;
  private lastInside: LatLon | null = null;
  private lastSample: { p: LatLon; t: number } | null = null;
  private joinedAs: string | null = null;

  constructor(
    private headers: () => Record<string, string>,
    private onEffects: (effects: Effect[]) => void,
  ) {}

  startPolling() {
    if (this.pollTimer) return;
    void this.refresh();
    this.pollTimer = setInterval(() => {
      // Fix responses already carry fresh state while running.
      if (!this.tracking || this.paused) void this.refresh();
    }, POLL_MS);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async refresh() {
    try {
      this.accept(await this.request("GET", "/event"));
    } catch (err) {
      this.fail(err);
    }
  }

  async join(name: string) {
    this.joinedAs = name;
    this.accept(await this.request("POST", "/event/join", { name }));
  }

  startTracking() {
    if (!navigator.geolocation) {
      this.gps = { kind: "error", message: "This browser has no GPS access." };
      return;
    }
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

  remainingMs(): number {
    if (!this.payload) return 0;
    const serverNow = this.payload.nowMs + (Date.now() - this.receivedAt);
    return Math.max(0, this.payload.endsAtMs - serverNow);
  }

  /** Map/UI view of the event in the same shape as the demo sim. */
  snapshot(): SimSnapshot | null {
    const p = this.payload;
    if (!p) return null;
    const seats: SimSnapshotSeat[] = p.seats.map((s) => {
      const at = s.position ?? s.respawnAt;
      const mine = s.id === p.yourSeatId;
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
      };
    });
    const top3 = [...seats]
      .sort((a, b) => b.areaM2 - a.areaM2)
      .slice(0, 3)
      .map(({ id, nickname, color, areaM2 }) => ({ id, nickname, color, areaM2 }));
    const you = seats.find((s) => s.id === p.yourSeatId) ?? null;
    const remainingMs = this.remainingMs();
    return {
      phase: p.phase,
      startedAtMs: p.startedAtMs,
      endsAtMs: p.endsAtMs,
      nowMs: p.endsAtMs - remainingMs,
      remainingMs,
      youNeedSpawn: !!you && ["joining", "toPlant", "ghost"].includes(you.mode),
      seats,
      top3,
      you,
      arena,
    };
  }

  /** Meters from your raw GPS to your plant marker, if you have one. */
  markerDistanceM(): number | null {
    const you = this.snapshot()?.you;
    if (!you?.respawnAt || !this.raw) return null;
    return haversineM(this.raw.lat, this.raw.lon, you.respawnAt.lat, you.respawnAt.lon);
  }

  private onPosition(pos: GeolocationPosition) {
    const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    this.raw = p;
    this.gps = { kind: "ok", accuracyM: pos.coords.accuracy };
    this.version++;
    if (this.paused) return;

    const inside = haversineM(p.lat, p.lon, arena.centerLat, arena.centerLon) <= arena.radiusM;
    if (!inside) {
      // Shown on the map only — never sent, so it can't count toward rank.
      if (!this.outside) {
        this.outsideTracks.push(this.lastInside ? [this.lastInside, p] : [p]);
      } else {
        this.outsideTracks[this.outsideTracks.length - 1]!.push(p);
      }
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
    if (this.sending || !this.pendingFix) return;
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
      const res = await this.request("POST", "/event/fix", {
        fix: {
          lat: p.lat,
          lon: p.lon,
          accuracyM: pos.coords.accuracy,
          speedMps: speed ?? 0,
          clientTsMs: pos.timestamp,
        },
      });
      this.accept(res);
      const effects = (res as { effects?: Effect[] }).effects ?? [];
      if (effects.length) this.onEffects(effects);
    } catch (err) {
      // A new weekly event started mid-run: rejoin and keep going.
      if (err instanceof Error && err.message === "not_joined" && this.joinedAs) {
        await this.join(this.joinedAs).catch((e) => this.fail(e));
      } else {
        this.fail(err);
      }
    } finally {
      this.sending = false;
      if (this.pendingFix) void this.flush();
    }
  }

  private accept(payload: unknown) {
    this.payload = payload as EventPayload;
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
        headers: { "Content-Type": "application/json", ...this.headers() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Can't reach the game server");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status >= 502) throw new Error("Can't reach the game server");
      if (res.status === 401) throw new Error("Couldn't verify your sign-in — sign in again");
      if (res.status === 409) throw new Error("not_joined");
      throw new Error(data.error ?? `Server error ${res.status}`);
    }
    return data;
  }
}
