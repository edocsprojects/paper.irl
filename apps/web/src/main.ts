import { buildArena, haversineM, KELLER, pointInTerritory, type Effect, type LatLon } from "@paper-irl/rules";
import { accessToken, authReady, initAuth, signInWithGoogle, signOut, type GoogleUser } from "./auth.js";
import { LocalMatch, type SimSnapshot, type SimSnapshotSeat } from "./botSim.js";
import { LiveMatch } from "./liveGame.js";
import { GameMap } from "./mapView.js";
import { HISTORY_MAX, loadProfile, saveProfile, type GameRecord } from "./profile.js";
import { startLoopScene } from "./loopScene.js";
import { COMMUNITY_EVENTS, type CommunityEvent } from "./events.js";
import "./styles.css";

/**
 * Your app's flow (Home → Create/Join → Lobby → countdown → Game → Results)
 * in the teammate's design. Home + Settings tabs are always visible.
 */
type Screen =
  | "intro"
  | "home"
  | "create"
  | "join"
  | "lobby"
  | "events"
  | "event"
  | "game"
  | "results"
  | "stats"
  | "settings";
const M_PER_MI = 1609.344;
const FT2_PER_ACRE = 43560;

/** "1.24 mi" (or feet under a tenth of a mile). */
function formatMiles(m: number): string {
  const mi = m / M_PER_MI;
  return mi < 0.1 ? `${Math.round(m * 3.28084).toLocaleString("en-US")} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
}

/** Big areas read better in acres (Strava-style compact numbers). */
function formatLand(m2: number): string {
  const ft2 = m2 * 10.7639;
  return ft2 >= FT2_PER_ACRE / 2 ? `${(ft2 / FT2_PER_ACRE).toFixed(2)} ac` : `${Math.round(ft2).toLocaleString("en-US")} ft²`;
}

/** Pace in min/mi, e.g. 12'05"/mi. */
function formatPace(ms: number, m: number): string {
  if (m < 30 || ms <= 0) return "–";
  const sPerMi = ms / 1000 / (m / M_PER_MI);
  const mm = Math.floor(sPerMi / 60);
  const ss = Math.round(sPerMi % 60).toString().padStart(2, "0");
  return mm > 99 ? "–" : `${mm}'${ss}"/mi`;
}
const DEAD_TEXT = "You're out — head back to your spawn area";
const OUTSIDE_TEXT = "You're outside the circle — head back in";
/** How long after the last out-of-bounds fix the "outside" snackbar stays up. */
const OUTSIDE_HOLD_MS = 2500;

const FT_PER_M = 3.28084;
const COUNTDOWN_STEP_MS = 700;
const SNACK_MS = 3000;
const KILL_FEED_MS = 8000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function formatMs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Imperial display; the game itself works in metres. */
function formatArea(m2: number): string {
  return `${Math.round(m2 * FT_PER_M * FT_PER_M).toLocaleString("en-US")} ft²`;
}

function formatFeet(m: number): string {
  return `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
}

function formatLatLon(p: LatLon): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Guests get a random 12-character handle (letters + digits). */
function randomGuestName(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const profile = loadProfile();
document.documentElement.dataset.theme = profile.theme;

type Config = { zoneFt: number; max: number; mins: number; sim: boolean; speed: number };
const isSim = () => profile.mode === "demo";

/** The game you're in (lobby, countdown, playing or results). */
type Session =
  | { kind: "sim"; match: LocalMatch; config: Config; center: LatLon }
  | { kind: "live"; config: Config | null }
  /** Keller Hall community event: local bots in Simulation, the server event otherwise. */
  | { kind: "event"; sim: LocalMatch | null; event: CommunityEvent };

type Phase = "lobby" | "countdown" | "playing" | "results";

async function main() {
  const map = await GameMap.create(buildArena());
  const live = new LiveMatch(
    (effects) => onYourEffects(effects),
    (): Record<string, string> => {
      const token = accessToken();
      return token ? { Authorization: `Bearer ${token}` } : { "X-Guest-Id": profile.guestId };
    },
  );
  /** Simulated events keep running in the background once opened. */
  const eventSims = new Map<string, LocalMatch>();
  /** Live summaries (players / time left) from GET /events in Real GPS. */
  let eventSummaries = new Map<string, { players: number; endsAtMs: number; nowMs: number }>();

  let screen: Screen = "intro";
  let session: Session | null = null;
  let phase: Phase | null = null;
  let config = { zoneFt: 1000, max: 8, mins: 10 };
  /** Create-time settings + Simulation (from Settings). */
  const fullConfig = (): Config => ({ ...config, sim: isSim(), speed: profile.demoSpeed });
  let here: LatLon | null = null;
  let countdownEnd = 0;
  let plantedOnce = false;
  let paused = false;
  let lastLiveVersion = -1;
  let last = performance.now();
  let lastUiPaint = 0;
  let seen = { feed: 0, notice: 0, pop: 0 };
  const raidAt = new Map<number, number>();
  let raidersInside = new Set<number>();
  let leaderId: number | null = null;
  let warnedMinute = false;
  let resultsSnap: SimSnapshot | null = null;

  /** This game's activity (distance, cuts, deaths…) for the Stats page. */
  type Run = {
    kind: "lobby" | "event";
    label?: string;
    sim: boolean;
    startMs: number;
    lastPos: LatLon | null;
    distanceM: number;
    cuts: number;
    deaths: number;
    bestClaimM2: number;
    stolenM2: number;
  };
  let run: Run | null = null;

  function startRun(kind: Run["kind"], sim: boolean) {
    const s = snap();
    run = {
      kind,
      sim,
      startMs: s?.nowMs ?? Date.now(),
      lastPos: null,
      distanceM: 0,
      cuts: 0,
      deaths: 0,
      bestClaimM2: 0,
      stolenM2: 0,
    };
  }

  /** Accumulate distance moved while you're alive (ignores respawn jumps). */
  function trackRun(s: SimSnapshot) {
    if (!run || phase !== "playing") return;
    const you = s.you;
    if (!you || !Number.isFinite(you.lat) || (you.mode !== "safe" && you.mode !== "trailing")) {
      if (run) run.lastPos = null;
      return;
    }
    const p = { lat: you.lat, lon: you.lon };
    if (run.lastPos) {
      const d = haversineM(run.lastPos.lat, run.lastPos.lon, p.lat, p.lon);
      if (d < 60) run.distanceM += d;
    }
    run.lastPos = p;
  }

  /** Save the game you just finished (or left) to your history + lifetime totals. */
  function recordRun(s: SimSnapshot | null) {
    const r = run;
    run = null;
    if (!r || !s) return;
    const durationMs = Math.max(0, s.nowMs - r.startMs);
    if (durationMs < 10_000 && r.distanceM < 20) return; // not really a game
    const ranked = [...s.seats].sort((a, b) => b.areaM2 - a.areaM2);
    const area = s.you?.areaM2 ?? 0;
    const rank = s.you && area > 0 ? ranked.findIndex((x) => x.id === s.you!.id) + 1 : null;
    const rec: GameRecord = {
      atMs: Date.now(),
      kind: r.kind,
      sim: r.sim,
      areaM2: area,
      rank,
      players: s.seats.length,
      distanceM: r.distanceM,
      durationMs,
      cuts: r.cuts,
      deaths: r.deaths,
      bestClaimM2: r.bestClaimM2,
      stolenM2: r.stolenM2,
      won: rank === 1,
      label: r.label,
    };
    profile.history = [rec, ...profile.history].slice(0, HISTORY_MAX);
    profile.gamesPlayed += 1;
    profile.allTimeScoreM2 += area;
    profile.bestGameM2 = Math.max(profile.bestGameM2, area);
    profile.totalPlayMs += durationMs;
    if (rank && (profile.bestRank === null || rank < profile.bestRank)) profile.bestRank = rank;
    if (rec.won) profile.wins += 1;
    profile.totalDistanceM += r.distanceM;
    profile.totalCuts += r.cuts;
    profile.totalDeaths += r.deaths;
    profile.totalStolenM2 += r.stolenM2;
    profile.bestClaimM2 = Math.max(profile.bestClaimM2, r.bestClaimM2);
    profile.longestRunM = Math.max(profile.longestRunM, r.distanceM);
    profile.mostCuts = Math.max(profile.mostCuts, r.cuts);
    saveProfile(profile);
  }

  // ---------- helpers ----------
  function snap(): SimSnapshot | null {
    if (!session) return null;
    if (session.kind === "sim") return session.match.snapshot();
    if (session.kind === "event" && session.sim) return session.sim.snapshot();
    return live.snapshot();
  }

  const youId = () =>
    session?.kind === "sim"
      ? session.match.youId
      : session?.kind === "event" && session.sim
        ? session.sim.youId
        : live.seatId;
  const isHost = () => session?.kind === "sim" || live.isHost;
  const inEvent = () => session?.kind === "event";

  function label(seat: { id: number; nickname: string }, you: number | null): string {
    return seat.id === you ? `${seat.nickname} (You)` : seat.nickname;
  }

  let toastTimer = 0;
  function toast(text: string) {
    const el = $("toast");
    el.textContent = text;
    el.classList.remove("hidden");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3800);
  }

  /** Single-slot snackbar about YOU; fades after 3 s. */
  let snackTimer = 0;
  let deadShown = false;
  /** Sticky "outside the circle" snackbar: last out-of-bounds fix (wall clock). */
  let outsideAt = 0;
  let outsideShown = false;
  function snack(text: string, tone: "good" | "bad" | "warn" | "" = "") {
    if (deadShown || outsideShown) return; // while you're out, the snackbar only says where to go
    const el = $("snackbar");
    el.textContent = text;
    el.className = `snackbar ${tone}`.trim();
    window.clearTimeout(snackTimer);
    snackTimer = window.setTimeout(() => el.classList.add("hidden"), SNACK_MS);
  }

  function killFeed(html: string, mine: boolean) {
    const root = $("kill-feed");
    const el = document.createElement("div");
    el.className = `kill-item${mine ? " mine" : ""}`;
    el.innerHTML = html;
    root.append(el);
    while (root.children.length > 4) root.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), KILL_FEED_MS);
  }

  function getHere(): Promise<LatLon | null> {
    if (!navigator.geolocation || !profile.useLocation) return Promise.resolve(null);
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 },
      ),
    );
  }

  // ---------- navigation ----------
  function show(next: Screen) {
    screen = next;
    document.querySelectorAll<HTMLElement>(".screen").forEach((el) => {
      el.hidden = el.dataset.screen !== next;
    });
    $("app").classList.toggle("on-intro", next === "intro");
    $("tabs").hidden = next === "intro";
    const tab = next === "settings" ? "settings" : next === "stats" ? "stats" : "home";
    document.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === tab && next !== "intro");
    });
    if (next === "game") {
      const s = snap();
      map.mount($("slot-game"), "follow", s);
      if (s) map.update(s, true);
    }
    if (next === "event") {
      const s = snap();
      map.mount($("slot-event"), "arena", s);
      if (s) map.update(s, phase === "playing");
    }
    paintUi(true);
  }

  /** Home tab returns to your game if one is running. */
  function goHome() {
    show("home");
  }

  document.querySelectorAll<HTMLElement>("[data-go]").forEach((el) =>
    el.addEventListener("click", () => show(el.dataset.go as Screen)),
  );
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
    el.addEventListener("click", () => {
      const tab = el.dataset.tab;
      if (tab === "settings") show("settings");
      else if (tab === "stats") show("stats");
      else goHome();
    }),
  );

  // ---------- intro / sign-in ----------
  function applyGoogleUser(user: GoogleUser) {
    profile.signIn = "google";
    if (user.name) profile.name = user.name.slice(0, 20);
    if (!profile.photo && user.photo) profile.photo = user.photo;
    saveProfile(profile);
  }

  function ensureGuestName() {
    if (profile.signIn === "guest" && (!profile.name || profile.name === "You")) {
      profile.name = randomGuestName();
      saveProfile(profile);
    }
  }

  const googleUser = await initAuth((user) => {
    if (user) applyGoogleUser(user);
    paintUi(true);
  }).catch(() => null);
  if (googleUser) applyGoogleUser(googleUser);
  ensureGuestName();

  document.querySelectorAll<HTMLElement>("[data-signin]").forEach((el) =>
    el.addEventListener("click", async () => {
      const kind = el.dataset.signin;
      if (kind === "apple") {
        toast("Sign in with Apple is coming soon. Use Google or continue as a guest.");
        return;
      }
      if (kind === "google") {
        if (!authReady) {
          toast("Google sign-in isn't set up yet. Continue as a guest for now.");
          return;
        }
        try {
          await signInWithGoogle();
        } catch (err) {
          toast(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      profile.signIn = "guest";
      ensureGuestName();
      show("home");
    }),
  );

  $("btn-signout").addEventListener("click", async () => {
    if (profile.signIn === "google") await signOut().catch(() => undefined);
    leaveSession();
    profile.signIn = null;
    profile.name = "You";
    saveProfile(profile);
    show("intro");
  });


  // ---------- Home ----------
  $("btn-create").addEventListener("click", () => {
    show("create");
    void getHere().then((p) => {
      here = p;
      paintUi(true);
    });
  });
  $("btn-join").addEventListener("click", () => show("join"));
  $("return-game").addEventListener("click", () =>
    show(phase === "lobby" ? "lobby" : phase === "results" ? "results" : "game"),
  );

  // ---------- Community event (Keller Hall) ----------
  $("btn-events").addEventListener("click", () => {
    show("events");
    void refreshEventSummaries();
  });

  async function refreshEventSummaries() {
    if (isSim()) return;
    try {
      const res = await fetch("/api/events");
      const j = (await res.json()) as { events: { id: string; players: number; endsAtMs: number; nowMs: number }[] };
      eventSummaries = new Map(j.events.map((e) => [e.id, e]));
    } catch {
      eventSummaries = new Map();
    }
    paintUi(true);
  }

  $("events-list").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-event]");
    const e = COMMUNITY_EVENTS.find((x) => x.id === btn?.dataset.event);
    if (e) void openEvent(e);
  });

  async function openEvent(e: CommunityEvent) {
    // Reuse the open event unless Settings switched Simulation / Real GPS.
    if (session?.kind === "event" && session.event.id === e.id && !!session.sim === isSim()) {
      show(phase === "playing" ? "game" : "event");
      return;
    }
    if (phase === "playing") recordRun(snap());
    leaveSession();
    if (isSim()) {
      let sim = eventSims.get(e.id);
      if (!sim || sim.ended) {
        sim = new LocalMatch({
          arena: buildArena({ radiusM: e.radiusM, centerLat: e.centerLat, centerLon: e.centerLon }),
          youName: profile.name,
          players: 8,
          durationMs: e.durationMs,
        });
        sim.youActive = false;
        sim.start();
        eventSims.set(e.id, sim);
      }
      session = { kind: "event", sim, event: e };
      phase = null;
      show("event");
    } else {
      // Show the event right away; the live state fills in when the server answers.
      session = { kind: "event", sim: null, event: e };
      phase = null;
      map.setArena(buildArena({ radiusM: e.radiusM, centerLat: e.centerLat, centerLon: e.centerLon }));
      show("event");
      try {
        await live.openEvent(e.id);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    }
  }

  $("btn-claim").addEventListener("click", async () => {
    if (session?.kind !== "event") return;
    if (session.sim) {
      session.sim.youActive = true;
    } else {
      if (!profile.useLocation) {
        toast("Location is off. Turn it on in Settings › Privacy to claim.");
        return;
      }
      try {
        await live.joinEvent(profile.name);
        live.startTracking();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    resetSnackbar();
    phase = "playing";
    startRun("event", !!session.sim);
    if (run) run.label = session.event.name;
    plantedOnce = false;
    seen = { feed: 0, notice: 0, pop: 0 };
    markSeen(snap());
    raidAt.clear();
    raidersInside = new Set();
    leaderId = null;
    warnedMinute = false;
    $("kill-feed").innerHTML = "";
    show("game");
  });

  // ---------- Create ----------
  for (const attr of ["zone", "max", "mins"] as const) {
    document.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach((el) =>
      el.addEventListener("click", () => {
        const v = Number(el.dataset[attr]);
        if (attr === "zone") config.zoneFt = v;
        if (attr === "max") config.max = v;
        if (attr === "mins") config.mins = v;
        paintUi(true);
      }),
    );
  }
  // Simulation lives in Settings.
  const speedRange = $<HTMLInputElement>("speed-range");
  speedRange.value = String(profile.demoSpeed);
  speedRange.addEventListener("input", () => {
    profile.demoSpeed = Number(speedRange.value) || 1;
    saveProfile(profile);
    if (session?.kind === "sim") session.config.speed = profile.demoSpeed;
    paintUi(true);
  });
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) =>
    el.addEventListener("click", () => {
      profile.mode = el.dataset.mode as "gps" | "demo";
      saveProfile(profile);
      paintUi(true);
    }),
  );

  function newSimMatch(cfg: Config, center: LatLon, fill = true): LocalMatch {
    return new LocalMatch({
      arena: buildArena({ radiusM: cfg.zoneFt / FT_PER_M, centerLat: center.lat, centerLon: center.lon }),
      youName: profile.name,
      players: cfg.max,
      durationMs: cfg.mins * 60_000,
      fill,
    });
  }

  /** Simulated lobby: players drop in one by one, like friends entering the code. */
  let arrivalTimer = 0;
  function scheduleArrival() {
    window.clearTimeout(arrivalTimer);
    arrivalTimer = window.setTimeout(() => {
      if (session?.kind !== "sim" || phase !== "lobby") return;
      if (session.match.addPlayer()) {
        paintUi(true);
        scheduleArrival();
      }
    }, 250 + Math.random() * 450);
  }

  $("btn-create-go").addEventListener("click", async () => {
    const cfg = fullConfig();
    const center = here ?? { lat: KELLER.lat, lon: KELLER.lon };
    leaveSession();
    if (cfg.sim) {
      // Simulation: same lobby as a real game; players join over a few seconds.
      session = { kind: "sim", match: newSimMatch(cfg, center, false), config: cfg, center };
      enterLobby();
      scheduleArrival();
      return;
    }
    if (!profile.useLocation) {
      toast("Location is off. Turn it on in Settings › Privacy.");
      return;
    }
    const btn = $<HTMLButtonElement>("btn-create-go");
    btn.disabled = true;
    try {
      if (!here) toast("Couldn't get your GPS — centering on Keller Hall.");
      await live.create({
        name: profile.name,
        center,
        radiusM: cfg.zoneFt / FT_PER_M,
        maxSeats: cfg.max,
        fillBots: false,
        durationMs: cfg.mins * 60_000,
      });
      await live.sendHere(center);
      session = { kind: "live", config: cfg };
      enterLobby();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Join ----------
  const codeInput = $<HTMLInputElement>("join-code");
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("btn-join-go").addEventListener("click", async () => {
    if (!profile.useLocation) {
      toast("Location is off. Turn it on in Settings › Privacy to join.");
      return;
    }
    const code = codeInput.value.trim();
    if (code.length < 4) {
      toast("Enter the game code");
      return;
    }
    const btn = $<HTMLButtonElement>("btn-join-go");
    btn.disabled = true;
    try {
      leaveSession();
      await live.join(code, profile.name);
      const p = await getHere();
      if (p) await live.sendHere(p);
      session = { kind: "live", config: null };
      enterLobby();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
    }
  });

  function startSim() {
    if (session?.kind !== "sim") return;
    phase = "lobby";
    plantedOnce = false;
    resultsSnap = null;
    session.match.start();
    beginCountdown();
  }

  // ---------- Lobby ----------
  function enterLobby() {
    phase = "lobby";
    plantedOnce = false;
    resultsSnap = null;
    show("lobby");
  }

  $("btn-lobby-start").addEventListener("click", async () => {
    if (!session) return;
    if (session.kind === "sim") {
      if (session.match.state.seats.size < 2) {
        toast("Wait for at least one more player");
        return;
      }
      window.clearTimeout(arrivalTimer);
      session.match.start();
      beginCountdown();
      return;
    }
    try {
      await live.start(); // everyone (incl. us) sees phase → live in the poll
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });

  function resetSnackbar() {
    deadShown = false;
    outsideShown = false;
    outsideAt = 0;
    window.clearTimeout(snackTimer);
    $("snackbar").className = "snackbar hidden";
  }

  function leaveSession() {
    resetSnackbar();
    window.clearTimeout(arrivalTimer);
    if (session?.kind === "live" || (session?.kind === "event" && !session.sim)) live.leave();
    if (session?.kind === "event" && session.sim) session.sim.youActive = false;
    session = null;
    phase = null;
    paused = false;
    $("kill-feed").innerHTML = "";
  }

  $("btn-lobby-leave").addEventListener("click", () => {
    leaveSession();
    goHome();
  });

  // ---------- Countdown → Game ----------
  function beginCountdown() {
    resetSnackbar();
    phase = "countdown";
    countdownEnd = performance.now() + COUNTDOWN_STEP_MS * 3;
    seen = { feed: 0, notice: 0, pop: 0 };
    markSeen(snap());
    raidAt.clear();
    raidersInside = new Set();
    leaderId = null;
    warnedMinute = false;
    $("kill-feed").innerHTML = "";
    if (session?.kind === "live") {
      live.armed = false;
      live.startTracking();
    }
    startRun("lobby", session?.kind === "sim");
    show("game");
  }

  $("btn-spawn").addEventListener("click", () => {
    live.armed = true;
    live.nudge();
    paintUi(true);
  });

  $("btn-zoom").addEventListener("click", () => {
    map.setZoomMode(map.zoomMode === "arena" ? "close" : "arena", snap());
    paintUi(true);
  });

  $("btn-leave").addEventListener("click", () => {
    if (phase === "playing") recordRun(snap());
    if (session?.kind === "event") {
      // Stop playing but keep watching the event.
      if (session.sim) session.sim.youActive = false;
      else live.stopTracking();
      phase = null;
      show("event");
      return;
    }
    leaveSession();
    goHome();
  });

  // ---------- Results ----------
  function endGame() {
    const s = snap();
    resultsSnap = s;
    recordRun(s);
    phase = "results";
    if (session?.kind === "live") live.stopTracking();
    show("results");
  }

  $("btn-again").addEventListener("click", async () => {
    if (!session) return;
    if (session.kind === "sim") {
      const cfg = { ...session.config, speed: profile.demoSpeed };
      session = { ...session, config: cfg, match: newSimMatch(cfg, session.center) };
      startSim();
      return;
    }
    try {
      await live.playAgain();
      $("results-hint").textContent = live.isHost ? "Starting…" : "Ready — waiting for the host";
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  $("btn-results-leave").addEventListener("click", () => {
    leaveSession();
    goHome();
  });

  // ---------- your effects + events ----------
  function onYourEffects(effects: Effect[]) {
    const me = youId();
    if (me === null || phase !== "playing") return;
    for (const e of effects) {
      if (e.kind === "banked" && e.seatId === me && e.gainedM2 >= 1) {
        snack(`+${formatArea(e.gainedM2)} claimed`, "good");
        if (run) run.bestClaimM2 = Math.max(run.bestClaimM2, e.gainedM2);
      }
      if (e.kind === "boundaryPush" && e.seatId === me) outsideAt = Date.now();
    }
  }

  function markSeen(s: SimSnapshot | null) {
    if (!s) return;
    const top = (xs: { atMs: number }[]) => xs.reduce((m, x) => Math.max(m, x.atMs), 0);
    seen = {
      feed: Math.max(seen.feed, top(s.feed)),
      notice: Math.max(seen.notice, top(s.notices)),
      pop: Math.max(seen.pop, top(s.pops)),
    };
  }

  /** Kill feed for everyone; snackbar only for things about YOU. */
  function observe(s: SimSnapshot) {
    const me = s.you?.id ?? null;
    const seat = (id: number) => s.seats.find((x) => x.id === id);
    const name = (id: number) => {
      const x = seat(id);
      return x ? label(x, me) : `Player ${id}`;
    };
    const dot = (id: number) => `<i style="background:${seat(id)?.color ?? "#999"}"></i>`;
    for (const f of s.feed) {
      if (f.atMs <= seen.feed) continue;
      const verb = f.reason === "captured" ? "took all of" : "cut";
      killFeed(
        `${dot(f.byId)}<b>${escapeHtml(name(f.byId))}</b> ${verb} <b>${escapeHtml(name(f.victimId))}</b>${f.reason === "captured" ? "'s land" : ""}${dot(f.victimId)}`,
        f.byId === me || f.victimId === me,
      );
      if (run && f.victimId === me) run.deaths += 1;
      if (run && f.byId === me && f.victimId !== me) run.cuts += 1;
      if (f.byId === me && f.victimId !== me) {
        snack(f.reason === "captured" ? `You took all of ${name(f.victimId)}'s land!` : `You cut ${name(f.victimId)}`, "good");
      }
    }
    for (const n of s.notices) {
      // Skip slivers (< ~50 ft²) so the snackbar only fires for real bites.
      if (n.atMs <= seen.notice || n.lostM2 < 5) continue;
      if (n.seatId === me && n.byId !== me) snack(`${name(n.byId)} took ${formatArea(n.lostM2)} of your land`, "bad");
      else if (n.byId === me) snack(`You took ${formatArea(n.lostM2)} from ${name(n.seatId)}`, "good");
      if (run && n.byId === me && n.seatId !== me) run.stolenM2 += n.lostM2;
    }
    for (const p of s.pops) {
      if (p.atMs <= seen.pop || p.seatId !== me) continue;
      deadShown = false; // planted again: the "you're out" snackbar is done
      snack(plantedOnce ? "You're back in!" : "You're in — leave your color to draw a trail", "good");
      plantedOnce = true;
    }
    markSeen(s);

    // Raid alert: someone's trail head inside your land.
    const you = s.you;
    const inside = new Set<number>();
    if (you && you.owned.length) {
      for (const o of s.seats) {
        if (o.id === me || o.mode !== "trailing" || !Number.isFinite(o.lat)) continue;
        if (!pointInTerritory({ lat: o.lat, lon: o.lon }, you.owned)) continue;
        inside.add(o.id);
        if (!raidersInside.has(o.id) && s.nowMs - (raidAt.get(o.id) ?? -1e12) > 10_000) {
          raidAt.set(o.id, s.nowMs);
          snack(`${o.nickname} is raiding your land — cut their trail!`, "warn");
        }
      }
    }
    raidersInside = inside;

    // Lead changes.
    const top = [...s.seats].sort((a, b) => b.areaM2 - a.areaM2)[0];
    if (top && top.areaM2 > 0) {
      if (leaderId !== null && leaderId !== top.id) {
        if (top.id === me) snack("You took the lead!", "good");
        else if (leaderId === me) snack(`${top.nickname} passed you for #1`, "warn");
      }
      leaderId = top.id;
    }

    if (!warnedMinute && s.remainingMs > 0 && s.remainingMs <= 60_000) {
      warnedMinute = true;
      snack("1 minute left!", "warn");
    }
  }

  // ---------- settings ----------
  const nameInput = $<HTMLInputElement>("name-input");
  const saveNameBtn = $<HTMLButtonElement>("btn-save-name");
  nameInput.addEventListener("input", () => {
    const v = nameInput.value.trim();
    saveNameBtn.disabled = profile.signIn !== "google" || !v || v === profile.name;
  });
  $("name-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (profile.signIn !== "google") return;
    const v = nameInput.value.trim().slice(0, 20);
    if (!v) return;
    profile.name = v;
    saveNameBtn.disabled = true;
    saveProfile(profile);
    toast("Name saved");
    paintUi(true);
  });

  $<HTMLInputElement>("photo-input").addEventListener("change", (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (file) void setPhoto(file);
  });

  async function setPhoto(file: File) {
    const bitmap = await createImageBitmap(file);
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const sz = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - sz) / 2, (bitmap.height - sz) / 2, sz, sz, 0, 0, size, size);
    profile.photo = canvas.toDataURL("image/jpeg", 0.85);
    saveProfile(profile);
    paintUi(true);
  }

  const themeToggle = $<HTMLInputElement>("theme-toggle");
  themeToggle.checked = profile.theme === "dark";
  themeToggle.addEventListener("change", () => {
    profile.theme = themeToggle.checked ? "dark" : "light";
    document.documentElement.dataset.theme = profile.theme;
    saveProfile(profile);
  });

  const privacyToggle = $<HTMLInputElement>("privacy-loc");
  privacyToggle.checked = profile.useLocation;
  privacyToggle.addEventListener("change", () => {
    profile.useLocation = privacyToggle.checked;
    saveProfile(profile);
    paintUi(true);
  });

  // ---------- painting ----------
  function rowHtml(s: SimSnapshotSeat | null, i: number, me: number | null, extra = ""): string {
    if (!s) {
      return `<li class="open"><span class="rank-n">${i + 1}</span><span class="avatar sm" style="background:var(--surface-2)"></span><span class="rank-name">Open</span><span></span></li>`;
    }
    const initial = s.id === me && profile.photo
      ? `<img src="${escapeHtml(profile.photo)}" alt="" />`
      : escapeHtml(/^Player (\d+)$/.exec(s.nickname)?.[1] ?? s.nickname.charAt(0).toUpperCase());
    return `<li class="${s.id === me ? "me" : ""}">
      <span class="rank-n">${i + 1}</span>
      <span class="avatar sm" style="background:${s.color}">${initial}</span>
      <span class="rank-name">${escapeHtml(label(s, me))}</span>
      <span class="rank-score">${extra}</span>
    </li>`;
  }

  function paintStats() {
    const h = profile.history;
    // This week (rolling 7 days, ending today).
    const day0 = new Date();
    day0.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => new Date(day0.getTime() - (6 - i) * 86_400_000));
    const inDay = (r: GameRecord, d: Date) => r.atMs >= d.getTime() && r.atMs < d.getTime() + 86_400_000;
    const week = h.filter((r) => r.atMs >= days[0]!.getTime());
    const sum = (rs: GameRecord[], k: "distanceM" | "areaM2") => rs.reduce((t, r) => t + r[k], 0);
    $("week-range").textContent = `${days[0]!.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – today`;
    $("wk-distance").textContent = formatMiles(sum(week, "distanceM"));
    $("wk-area").textContent = formatLand(sum(week, "areaM2"));
    $("wk-games").textContent = String(week.length);
    const perDay = days.map((d) => sum(h.filter((r) => inDay(r, d)), "areaM2"));
    const max = Math.max(1, ...perDay);
    $("week-bars").innerHTML = days
      .map((d, i) => {
        const v = perDay[i]!;
        const pct = Math.max(3, Math.round((v / max) * 100));
        const label = d.toLocaleDateString("en-US", { weekday: "narrow" });
        return `<div class="week-bar${v ? "" : " empty"}${i === 6 ? " today" : ""}" title="${formatLand(v)}"><i style="height:${v ? pct : 3}%"></i><span>${label}</span></div>`;
      })
      .join("");

    // Personal records.
    const prs: [string, string, string][] = [
      ["XL", "Biggest single claim", profile.bestClaimM2 ? formatLand(profile.bestClaimM2) : "–"],
      ["TOP", "Best game", profile.bestGameM2 ? formatLand(profile.bestGameM2) : "–"],
      ["MI", "Longest run", profile.longestRunM ? formatMiles(profile.longestRunM) : "–"],
      ["#", "Best finish", profile.bestRank ? `#${profile.bestRank}` : "–"],
      ["CUT", "Most cuts in a game", profile.mostCuts ? String(profile.mostCuts) : "–"],
    ];
    $("pr-list").innerHTML = prs
      .map(([b, l, v]) => `<div class="pr-row"><span class="pr-badge">${b}</span><span class="pr-label">${l}</span><strong>${v}</strong></div>`)
      .join("");

    // All-time.
    const stats: [string, string][] = [
      ["Distance", formatMiles(profile.totalDistanceM)],
      ["Land claimed", formatLand(profile.allTimeScoreM2)],
      ["Games", String(profile.gamesPlayed)],
      ["Wins", String(profile.wins)],
      ["Time moving", formatMs(profile.totalPlayMs)],
      ["Avg pace", formatPace(profile.totalPlayMs, profile.totalDistanceM)],
      ["Cuts / deaths", `${profile.totalCuts} / ${profile.totalDeaths}`],
      ["Land stolen", formatLand(profile.totalStolenM2)],
    ];
    $("stats").innerHTML = stats
      .map(([l, v]) => `<div class="tile"><span class="tile-label">${l}</span><strong>${v}</strong></div>`)
      .join("");

    // Recent games.
    $("activity-list").innerHTML = h.length
      ? h
          .slice(0, 10)
          .map((r) => {
            const when = new Date(r.atMs).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
            const title = r.kind === "event" ? (r.label ?? "Community event") : r.won ? "Won a game" : "Game";
            return `<li class="activity">
              <div class="activity-head"><strong>${title}</strong><span>${when}</span></div>
              <div class="activity-figs">
                <div><strong>${formatLand(r.areaM2)}</strong><span>Land</span></div>
                <div><strong>${formatMiles(r.distanceM)}</strong><span>Distance</span></div>
                <div><strong>${formatMs(r.durationMs)}</strong><span>Time</span></div>
                <div><strong>${r.rank ? `#${r.rank}/${r.players}` : "–"}</strong><span>Rank</span></div>
              </div>
            </li>`;
          })
          .join("")
      : `<li class="empty">No games yet</li>`;
  }

  function paintUi(force = false) {
    const now = performance.now();
    if (!force && now - lastUiPaint < 200) return;
    lastUiPaint = now;
    const s = screen === "results" ? resultsSnap ?? snap() : snap();
    const me = youId();

    if (screen === "home") {
      const inGame = !!session && phase !== null;
      $("return-game").classList.toggle("hidden", !inGame);
      if (inGame) {
        const g = snap();
        const left =
          phase === "playing" && g ? formatMs(g.remainingMs) : "";
        $("return-sub").textContent = left;
      }
    }

    if (screen === "create") {
      const pick = (attr: string, val: number) =>
        document.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach((el) => {
          const on = Number(el.dataset[attr]) === val;
          el.classList.toggle("active", on);
          el.setAttribute("aria-checked", String(on));
        });
      pick("zone", config.zoneFt);
      pick("max", config.max);
      pick("mins", config.mins);
      $("create-where").textContent = here ? "Arena centre · your location" : "Arena centre · Keller Hall (no GPS)";
      $("create-coords").textContent = formatLatLon(here ?? { lat: KELLER.lat, lon: KELLER.lon });

    }

    if (screen === "lobby") {
      const seats = s?.seats ?? [];
      const max = session?.kind === "sim" ? session.match.state.maxSeats : live.payload?.maxSeats ?? 8;
      const arena = s?.arena;
      $("lobby-title").textContent = "Lobby";
      $("lobby-kind").textContent = "Game code";
      $("lobby-code").textContent = s?.code ?? "——————";
      $("lobby-meta").textContent = arena
        ? `${formatLatLon({ lat: arena.centerLat, lon: arena.centerLon })} · ${formatFeet(arena.radiusM)} radius · max ${max}`
        : "";
      $("lobby-count").textContent = `Players · ${seats.length}/${max}`;
      const rows: string[] = [];
      for (let i = 0; i < max; i++) {
        const seat = seats[i] ?? null;
        rows.push(rowHtml(seat, i, me, seat && i === 0 ? '<span class="host-tag">HOST</span>' : ""));
      }
      $("lobby-list").innerHTML = rows.join("");
      $("btn-lobby-start").classList.toggle("hidden", !isHost());
      $("lobby-hint").textContent = live.serverError && session?.kind === "live"
        ? live.serverError
        : isHost()
          ? seats.length < 2
            ? "Share the code — waiting for players to join…"
            : "Start when everyone's in."
          : "Waiting for the host to start…";
    }

    if (screen === "events") {
      $("events-list").innerHTML = COMMUNITY_EVENTS.map((e) => {
        const live = eventSummaries.get(e.id);
        const mins = live ? Math.max(1, Math.ceil((live.endsAtMs - live.nowMs) / 60_000)) : 0;
        const left = live ? `${mins} min left · ${live.players} playing` : "1-hour event";
        const active = session?.kind === "event" && session.event.id === e.id ? " · You're here" : "";
        return `<button class="place" type="button" data-event="${e.id}">
          <span class="place-name">${escapeHtml(e.name)}</span>
          <span class="place-sub">${escapeHtml(e.place)} · ${left}${active}</span>
        </button>`;
      }).join("");
    }

    if (screen === "event") {
      if (session?.kind === "event") $("event-name").textContent = session.event.name;
      const ranked = s ? [...s.seats].sort((a, b) => b.areaM2 - a.areaM2) : [];
      const you = s?.you ?? null;
      const rank = you && you.areaM2 > 0 ? ranked.findIndex((x) => x.id === you.id) + 1 : 0;
      $("event-score").textContent = formatArea(phase === "playing" || (you?.areaM2 ?? 0) > 0 ? you?.areaM2 ?? 0 : 0);
      $("event-rank").textContent = rank ? `#${rank}` : "–";
      $("event-timer").textContent = s ? formatMs(s.remainingMs) : "–";
      const winner = session?.kind === "event" && !session.sim ? live.lastWinner : null;
      $("event-winner").classList.toggle("hidden", !winner);
      if (winner) $("event-winner").innerHTML = `Last event winner: <strong>${escapeHtml(winner.name)}</strong> · ${formatArea(winner.areaM2)}`;
      const err = session?.kind === "event" && !session.sim ? live.serverError : null;
      $("event-alert").classList.toggle("hidden", !err);
      if (err) $("event-alert").textContent = err;
      $("event-hint").textContent = `${s?.seats.length ?? 0} playing now`;
    }

    if (screen === "game" && s) {
      const ranked = [...s.seats].sort((a, b) => b.areaM2 - a.areaM2).slice(0, 3);
      const arenaArea = Math.PI * s.arena.radiusM ** 2;
      $("hud-board").innerHTML = ranked
        .map((x, i) => {
          const pct = (x.areaM2 / arenaArea) * 100;
          return `<li class="${x.id === me ? "me" : ""}"><span class="n">${i + 1}</span><span class="dot" style="background:${x.color}"></span><span class="nm">${escapeHtml(label(x, me))}</span><span class="pct">${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span></li>`;
        })
        .join("");
      $("hud-timer").textContent = formatMs(s.remainingMs);
      $("btn-zoom").textContent = map.zoomMode === "arena" ? "Zoom in" : "Zoom out";
      const cd = phase === "countdown" ? Math.ceil((countdownEnd - now) / COUNTDOWN_STEP_MS) : 0;
      $("countdown").classList.toggle("hidden", cd <= 0);
      $("countdown").textContent = cd > 0 ? String(cd) : "";
      const mode = s.you?.mode;
      const waitingFirstSpawn = session?.kind === "live" && phase === "playing" && !live.armed;
      $("spawn-gate").classList.toggle("hidden", !waitingFirstSpawn);
      const out = phase === "playing" && (mode === "ghost" || ((mode === "toPlant" || mode === "joining") && plantedOnce));
      // While you're out (dead, or outside the circle) the snackbar stays put with where to go.
      // Live games never send fixes from outside the circle, so ask the GPS tracker directly.
      const liveOutside = (session?.kind === "live" || (session?.kind === "event" && !session.sim)) && live.outside;
      const outside = !out && phase === "playing" && (liveOutside || Date.now() - outsideAt < OUTSIDE_HOLD_MS);
      const el = $("snackbar");
      if (out && !deadShown) {
        deadShown = true;
        outsideShown = false;
        window.clearTimeout(snackTimer);
        el.textContent = DEAD_TEXT;
        el.className = "snackbar dead";
      } else if (!out && deadShown) {
        deadShown = false;
        el.className = "snackbar hidden";
      }
      if (outside && !outsideShown) {
        outsideShown = true;
        window.clearTimeout(snackTimer);
        el.textContent = OUTSIDE_TEXT;
        el.className = "snackbar warn";
      } else if (!outside && outsideShown) {
        outsideShown = false;
        el.className = "snackbar hidden";
      }
    }

    if (screen === "results" && s) {
      const ranked = [...s.seats].sort((a, b) => b.areaM2 - a.areaM2);
      $("results-list").innerHTML = ranked
        .map((x, i) => rowHtml(x, i, me, formatArea(x.areaM2)))
        .join("");
      const rank = s.you ? ranked.findIndex((x) => x.id === s.you!.id) + 1 : 0;
      $("results-score").textContent = formatArea(s.you?.areaM2 ?? 0);
      $("results-rank").textContent = rank ? `#${rank} of ${ranked.length}` : "–";
      if (session?.kind === "live" && !$("results-hint").textContent) {
        const ready = live.payload?.rematchReady?.length ?? 0;
        $("results-hint").textContent = `Same lobby · ${ready}/${ranked.length} ready`;
      }
    }

    if (screen === "stats") paintStats();

    if (screen === "settings") {
      const av = $("me-avatar");
      av.style.background = "#e85d04";
      av.innerHTML = profile.photo
        ? `<img src="${escapeHtml(profile.photo)}" alt="" referrerpolicy="no-referrer" />`
        : escapeHtml(profile.name.charAt(0).toUpperCase());
      $("saved-name").textContent = profile.name;
      $("account-line").textContent = profile.signIn === "google" ? "Signed in with Google" : "Playing as a guest";
      const guest = profile.signIn !== "google";
      if (document.activeElement !== nameInput) nameInput.value = profile.name;
      nameInput.readOnly = guest;
      if (guest) saveNameBtn.disabled = true;
      $("name-hint").textContent = guest ? "Guests get a random name. Sign in to change it." : "";
      $("privacy-warning").classList.toggle("hidden", profile.useLocation);
      document.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
        const on = el.dataset.mode === profile.mode;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", String(on));
      });
      $("sim-speed").classList.toggle("hidden", !isSim());
      $("speed-value").textContent = `${profile.demoSpeed}×`;

    }
  }

  // ---------- main loop ----------
  function frame(now: number) {
    try {
      step(now);
    } catch (err) {
      console.error(err);
    }
    requestAnimationFrame(frame);
  }

  function step(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (phase === "countdown" && now >= countdownEnd) {
      phase = "playing";
      paintUi(true);
    }

    if (session?.kind === "sim") {
      const m = session.match;
      if ((phase === "playing" || phase === "countdown") && !paused && phase === "playing") {
        const effects = m.advance(dt, session.config.speed);
        if (effects.length) onYourEffects(effects);
      }
      const s = m.snapshot();
      if (phase === "playing") {
        observe(s);
        trackRun(s);
      }
      if (screen === "game") map.update(s, true);
      if (phase === "playing" && m.ended) endGame();
    } else if (session?.kind === "event" && session.sim) {
      const m = session.sim;
      const effects = m.advance(dt, profile.demoSpeed);
      if (effects.length) onYourEffects(effects);
      const s = m.snapshot();
      if (phase === "playing") {
        observe(s);
        trackRun(s);
      }
      if (screen === "game" || screen === "event") map.update(s, phase === "playing");
    } else if (session?.kind === "event" && live.version !== lastLiveVersion) {
      lastLiveVersion = live.version;
      const s = live.snapshot();
      if (s) {
        if (phase === "playing") {
          observe(s);
          trackRun(s);
        }
        if (screen === "game" || screen === "event") {
          map.update(s, phase === "playing");
          if (phase === "playing") map.setOutsideTracks(live.outsideTracks);
        }
      }
      paintUi(true);
    } else if (session?.kind === "live" && live.version !== lastLiveVersion) {
      lastLiveVersion = live.version;
      const s = live.snapshot();
      if (s) {
        if (phase === "lobby" && s.phase === "live") beginCountdown();
        if (phase === "results" && s.phase === "live") {
          $("results-hint").textContent = "";
          enterLobby();
          beginCountdown();
        }
        if (phase === "playing") {
          observe(s);
          trackRun(s);
        }
        if (screen === "game") {
          map.update(s, true);
          map.setOutsideTracks(live.outsideTracks);
        }
        if (phase === "playing" && s.phase === "ended") endGame();
      }
      paintUi(true);
    }
    paintUi();
  }

  const scene = document.querySelector<SVGSVGElement>(".loop-scene");
  if (scene) startLoopScene(scene, () => screen === "intro");

  show(profile.signIn === null ? "intro" : "home");
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#c00;padding:2rem;font-family:Manrope,sans-serif">App failed: ${escapeHtml(String(err))}</pre>`;
});
