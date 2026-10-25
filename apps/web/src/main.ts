import { buildArena, KELLER, pointInTerritory, type Effect, type LatLon } from "@paper-irl/rules";
import { authReady, initAuth, signInWithGoogle, signOut, type GoogleUser } from "./auth.js";
import { LocalMatch, type SimSnapshot, type SimSnapshotSeat } from "./botSim.js";
import { LiveMatch } from "./liveGame.js";
import { GameMap } from "./mapView.js";
import { loadProfile, saveProfile } from "./profile.js";
import "./styles.css";

/**
 * Your app's flow (Home → Create/Join → Lobby → countdown → Game → Results)
 * in the teammate's design. Home + Settings tabs are always visible.
 */
type Screen = "intro" | "home" | "create" | "join" | "lobby" | "game" | "results" | "settings";

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

/** The game you're in (lobby, countdown, playing or results). */
type Session =
  | { kind: "sim"; match: LocalMatch; config: Config; center: LatLon }
  | { kind: "live"; config: Config | null };

type Phase = "lobby" | "countdown" | "playing" | "results";

async function main() {
  const map = await GameMap.create(buildArena());
  const live = new LiveMatch((effects) => onYourEffects(effects));

  let screen: Screen = "intro";
  let session: Session | null = null;
  let phase: Phase | null = null;
  let config: Config = { zoneFt: 1000, max: 8, mins: 10, sim: false, speed: profile.demoSpeed };
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

  // ---------- helpers ----------
  function snap(): SimSnapshot | null {
    if (!session) return null;
    return session.kind === "sim" ? session.match.snapshot() : live.snapshot();
  }

  const youId = () => (session?.kind === "sim" ? session.match.youId : live.seatId);
  const isHost = () => session?.kind === "sim" || live.isHost;

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
  function snack(text: string, tone: "good" | "bad" | "warn" | "" = "") {
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
    const tab = next === "settings" ? "settings" : "home";
    document.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === tab && next !== "intro");
    });
    if (next === "game") {
      const s = snap();
      map.mount($("slot-game"), "follow", s);
      if (s) map.update(s, true);
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
    el.addEventListener("click", () => (el.dataset.tab === "settings" ? show("settings") : goHome())),
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

  // Home hero = the intro's illustrated map.
  const heroSvg = document.querySelector(".intro-map")?.cloneNode(true);
  if (heroSvg) $("home-hero").append(heroSvg);

  // ---------- Home ----------
  $("btn-create").addEventListener("click", () => {
    show("create");
    void getHere().then((p) => {
      here = p;
      paintUi(true);
    });
  });
  $("btn-join").addEventListener("click", () => show("join"));
  $("btn-return").addEventListener("click", () => show(phase === "lobby" ? "lobby" : phase === "results" ? "results" : "game"));

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
  const simToggle = $<HTMLInputElement>("sim-toggle");
  simToggle.addEventListener("change", () => {
    config.sim = simToggle.checked;
    paintUi(true);
  });
  const speedRange = $<HTMLInputElement>("speed-range");
  speedRange.value = String(config.speed);
  speedRange.addEventListener("input", () => {
    config.speed = Number(speedRange.value) || 1;
    profile.demoSpeed = config.speed;
    saveProfile(profile);
    paintUi(true);
  });

  function newSimMatch(cfg: Config, center: LatLon): LocalMatch {
    return new LocalMatch({
      arena: buildArena({ radiusM: cfg.zoneFt / FT_PER_M, centerLat: center.lat, centerLon: center.lon }),
      youName: profile.name,
      players: cfg.max,
      durationMs: cfg.mins * 60_000,
    });
  }

  $("btn-create-go").addEventListener("click", async () => {
    const cfg = { ...config };
    const center = here ?? { lat: KELLER.lat, lon: KELLER.lon };
    leaveSession();
    if (cfg.sim) {
      session = { kind: "sim", match: newSimMatch(cfg, center), config: cfg, center };
      enterLobby();
      return;
    }
    if (!profile.useLocation) {
      toast("Location is off. Turn it on in Settings › Privacy, or use Simulation.");
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

  function leaveSession() {
    if (session?.kind === "live") live.leave();
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
    leaveSession();
    goHome();
  });

  // ---------- Results ----------
  function endGame() {
    const s = snap();
    resultsSnap = s;
    phase = "results";
    const you = s?.you ?? null;
    const ranked = s ? [...s.seats].sort((a, b) => b.areaM2 - a.areaM2) : [];
    const rank = you ? ranked.findIndex((x) => x.id === you.id) + 1 : 0;
    const area = you?.areaM2 ?? 0;
    profile.gamesPlayed += 1;
    profile.allTimeScoreM2 += area;
    profile.bestGameM2 = Math.max(profile.bestGameM2, area);
    profile.totalPlayMs += s ? Math.max(0, s.nowMs - s.startedAtMs) : 0;
    if (rank && area > 0 && (profile.bestRank === null || rank < profile.bestRank)) profile.bestRank = rank;
    if (rank === 1 && area > 0) profile.wins += 1;
    saveProfile(profile);
    if (session?.kind === "live") live.stopTracking();
    show("results");
  }

  $("btn-again").addEventListener("click", async () => {
    if (!session) return;
    if (session.kind === "sim") {
      session = { ...session, match: newSimMatch(session.config, session.center) };
      enterLobby();
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
      if (e.kind === "banked" && e.seatId === me && e.gainedM2 >= 1) snack(`+${formatArea(e.gainedM2)} claimed`, "good");
      if (e.kind === "boundaryPush" && e.seatId === me) snack("Outside the boundary", "warn");
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
      if (f.byId === me && f.victimId !== me) {
        snack(f.reason === "captured" ? `You took all of ${name(f.victimId)}'s land!` : `You cut ${name(f.victimId)}`, "good");
      }
    }
    for (const n of s.notices) {
      // Skip slivers (< ~50 ft²) so the snackbar only fires for real bites.
      if (n.atMs <= seen.notice || n.lostM2 < 5) continue;
      if (n.seatId === me && n.byId !== me) snack(`${name(n.byId)} took ${formatArea(n.lostM2)} of your land`, "bad");
      else if (n.byId === me) snack(`You took ${formatArea(n.lostM2)} from ${name(n.seatId)}`, "good");
    }
    for (const p of s.pops) {
      if (p.atMs <= seen.pop || p.seatId !== me) continue;
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

  function paintUi(force = false) {
    const now = performance.now();
    if (!force && now - lastUiPaint < 200) return;
    lastUiPaint = now;
    const s = screen === "results" ? resultsSnap ?? snap() : snap();
    const me = youId();

    if (screen === "home") {
      const inGame = !!session && phase !== null;
      $("return-game").classList.toggle("hidden", !inGame);
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
      simToggle.checked = config.sim;
      $("sim-speed").classList.toggle("hidden", !config.sim);
      $("speed-value").textContent = `${config.speed}×`;
      $("create-where").textContent = here ? "Arena centre · your location" : "Arena centre · Keller Hall (no GPS)";
      $("create-coords").textContent = formatLatLon(here ?? { lat: KELLER.lat, lon: KELLER.lon });
      $("create-hint").textContent = config.sim
        ? `Bots fill every spot and you run on autopilot at ${config.speed}×.`
        : "Real players only — share the code so friends can join.";
    }

    if (screen === "lobby") {
      const seats = s?.seats ?? [];
      const max = session?.kind === "sim" ? session.match.state.maxSeats : live.payload?.maxSeats ?? 8;
      const arena = s?.arena;
      $("lobby-title").textContent = session?.kind === "sim" ? "Simulation lobby" : "Lobby";
      $("lobby-kind").textContent = session?.kind === "sim" ? "Simulation" : "Game code";
      $("lobby-code").textContent = session?.kind === "sim" ? `${(session.config.speed)}×` : s?.code ?? "——————";
      $("lobby-meta").textContent = arena
        ? `${formatLatLon({ lat: arena.centerLat, lon: arena.centerLon })} · ${formatFeet(arena.radiusM)} radius · max ${max}`
        : "";
      $("lobby-count").textContent = `Players · ${seats.length}/${max}`;
      const rows: string[] = [];
      for (let i = 0; i < max; i++) {
        const seat = seats[i] ?? null;
        rows.push(rowHtml(seat, i, me, seat && i === 0 ? '<span class="host-tag">HOST</span>' : seat?.bot ? "bot" : ""));
      }
      $("lobby-list").innerHTML = rows.join("");
      $("btn-lobby-start").classList.toggle("hidden", !isHost());
      $("lobby-hint").textContent = live.serverError && session?.kind === "live"
        ? live.serverError
        : isHost()
          ? "Start when everyone's in."
          : "Waiting for the host to start…";
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
      $("hud-timer").textContent = formatMs(phase === "countdown" ? s.remainingMs : s.remainingMs);
      $("btn-zoom").textContent = map.zoomMode === "arena" ? "Zoom in" : "Zoom out";
      const cd = phase === "countdown" ? Math.ceil((countdownEnd - now) / COUNTDOWN_STEP_MS) : 0;
      $("countdown").classList.toggle("hidden", cd <= 0);
      $("countdown").textContent = cd > 0 ? String(cd) : "";
      const mode = s.you?.mode;
      const waitingFirstSpawn = session?.kind === "live" && phase === "playing" && !live.armed;
      $("spawn-gate").classList.toggle("hidden", !waitingFirstSpawn);
      const out = mode === "ghost" || ((mode === "toPlant" || mode === "joining") && plantedOnce);
      $("respawn-hint").classList.toggle("hidden", !(phase === "playing" && out));
    }

    if (screen === "results" && s) {
      const ranked = [...s.seats].sort((a, b) => b.areaM2 - a.areaM2);
      $("results-list").innerHTML = ranked
        .slice(0, 3)
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
      $("name-hint").textContent = guest ? "Guests get a random name. Sign in with Google to change it." : "";
      $("privacy-warning").classList.toggle("hidden", profile.useLocation);
      const avg = profile.gamesPlayed ? profile.allTimeScoreM2 / profile.gamesPlayed : 0;
      const stats: [string, string][] = [
        ["All time score", formatArea(profile.allTimeScoreM2)],
        ["Best rank", profile.bestRank ? `#${profile.bestRank}` : "–"],
        ["Games", String(profile.gamesPlayed)],
        ["Games won", String(profile.wins)],
        ["Best game", formatArea(profile.bestGameM2)],
        ["Avg per game", formatArea(avg)],
        ["Time played", formatMs(profile.totalPlayMs)],
      ];
      $("stats").innerHTML = stats
        .map(([l, v]) => `<div class="tile"><span class="tile-label">${l}</span><strong>${v}</strong></div>`)
        .join("");
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
      if (phase === "playing") observe(s);
      if (screen === "game") map.update(s, true);
      if (phase === "playing" && m.ended) endGame();
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
        if (phase === "playing") observe(s);
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

  show(profile.signIn === null ? "intro" : "home");
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#c00;padding:2rem;font-family:Manrope,sans-serif">App failed: ${escapeHtml(String(err))}</pre>`;
});
