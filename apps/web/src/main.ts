import { buildArena, haversineM, KELLER, type Effect, type LatLon } from "@paper-irl/rules";
import {
  authReady,
  initAuth,
  signInWithGoogle,
  signOut,
  type GoogleUser,
} from "./auth.js";
import { LocalMatch, type SimSnapshot, type SimSnapshotSeat } from "./botSim.js";
import { LiveMatch } from "./liveGame.js";
import { GameMap, type Camera } from "./mapView.js";
import { loadProfile, saveProfile } from "./profile.js";
import "./styles.css";

type Screen =
  | "intro"
  | "location"
  | "lobby"
  | "create"
  | "join"
  | "room"
  | "play"
  | "done"
  | "ranks"
  | "profile"
  | "player";

const TAB_SCREENS: Screen[] = ["lobby", "ranks", "profile", "player"];

const MAP_SLOTS: Partial<Record<Screen, { slot: string; camera: Camera }>> = {
  lobby: { slot: "slot-lobby", camera: "arena" },
  play: { slot: "slot-play", camera: "follow" },
  done: { slot: "slot-done", camera: "yourLand" },
};

const FT_PER_M = 3.28084;
const ATTRACT_RADIUS_M = 300;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** m:ss, or h:mm:ss past an hour. */
function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Imperial display; the game itself works in metres. */
function formatArea(m2: number): string {
  return `${Math.round(m2 * FT_PER_M * FT_PER_M).toLocaleString("en-US")} ft²`;
}

function formatDist(m: number): string {
  const ft = m * FT_PER_M;
  return ft >= 5280 ? `${(ft / 5280).toFixed(1)} mi` : `${Math.round(ft).toLocaleString("en-US")} ft`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const profile = loadProfile();
document.documentElement.dataset.theme = profile.theme;

type SeatLike = { id: number; nickname: string; color: string };

function ranked(snap: SimSnapshot): SimSnapshotSeat[] {
  return [...snap.seats].sort((a, b) => b.areaM2 - a.areaM2);
}

function rankOf(snap: SimSnapshot | null, id: number | null | undefined): number | null {
  if (!snap || id == null) return null;
  const list = ranked(snap);
  const i = list.findIndex((s) => s.id === id);
  return i < 0 || list[i]!.areaM2 <= 0 ? null : i + 1;
}

let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3800);
}

/** Short-lived message list (claim feed on Home, kill feed + snacks while playing). */
class Feed {
  private lastArea = new Map<number, number>();
  constructor(
    private root: HTMLElement,
    private max: number,
    private ttlMs = 6000,
  ) {}

  push(text: string, tone = "") {
    const el = document.createElement("div");
    el.className = `feed-item ${tone}`.trim();
    el.textContent = text;
    this.root.prepend(el);
    while (this.root.children.length > this.max) this.root.lastElementChild?.remove();
    window.setTimeout(() => el.remove(), this.ttlMs);
  }

  /** "Player 3 just claimed 340 ft²!" from area changes between snapshots. */
  observe(snap: SimSnapshot, name: (s: SeatLike) => string) {
    for (const seat of snap.seats) {
      const prev = this.lastArea.get(seat.id);
      this.lastArea.set(seat.id, seat.areaM2);
      if (prev === undefined) continue;
      const delta = seat.areaM2 - prev;
      if (delta >= 1 && prev > 0) this.push(`${name(seat)} just claimed ${formatArea(delta)}!`);
    }
  }

  reset() {
    this.lastArea.clear();
    this.root.innerHTML = "";
  }
}

/** Everything about the game you're in right now. */
type Game =
  | { kind: "sim"; match: LocalMatch; startedAt: number; startArea: number }
  | { kind: "live"; startedAt: number; startArea: number };

async function main() {
  const kellerArena = buildArena({ radiusM: ATTRACT_RADIUS_M });
  /** Bots-only background match so Home always shows a live map. */
  let attract = new LocalMatch({ arena: kellerArena, players: 7, durationMs: 60 * 60_000 });
  const map = await GameMap.create(kellerArena);
  const feed = new Feed($("feed"), 3);
  const snacks = new Feed($("snacks"), 2, 3500);
  const killFeed = new Feed($("play-feed"), 3, 6000);
  const live = new LiveMatch((effects) => onYourEffects(effects));

  let screen: Screen = "intro";
  const history: Screen[] = [];
  let paused = false;
  let game: Game | null = null;
  /** Last game's final snapshot (Ranks / Done after you leave). */
  let lastSnap: SimSnapshot | null = null;
  let viewingId = 0;
  let lastUiPaint = 0;
  let lastLiveVersion = -1;
  let last = performance.now();
  let seen = { feed: 0, notice: 0, pop: 0 };
  let createOpts = { zoneFt: 1000, max: 8, mins: 10 };

  const isSim = () => profile.mode === "demo";
  const youIdOf = (snap: SimSnapshot | null) => snap?.you?.id ?? null;

  /** What the map/UI should show right now. */
  function currentSnap(): SimSnapshot | null {
    if (game?.kind === "sim") return game.match.snapshot();
    if (game?.kind === "live") return live.snapshot();
    if (screen === "room") return live.snapshot();
    if (screen === "ranks" || screen === "player" || screen === "done") return lastSnap;
    return attract.snapshot();
  }

  function displayName(seat: SeatLike, youId: number | null): string {
    if (seat.id !== youId) return seat.nickname;
    return profile.name === "You" ? "You" : `${profile.name} (You)`;
  }

  function avatarHtml(seat: SeatLike, youId: number | null): string {
    if (seat.id === youId && profile.photo) {
      return `<img src="${escapeHtml(profile.photo)}" alt="" referrerpolicy="no-referrer" />`;
    }
    const n = seat.id === youId ? profile.name : seat.nickname;
    const m = /^Player (\d+)$/.exec(n);
    return escapeHtml(m ? m[1]! : n.charAt(0).toUpperCase());
  }

  function paintAvatar(el: HTMLElement, seat: SeatLike, youId: number | null) {
    el.style.background = seat.color;
    el.innerHTML = avatarHtml(seat, youId);
  }

  /** Effects from your own moves (sim tick or your GPS fix). */
  function onYourEffects(effects: Effect[]) {
    const youId = youIdOf(currentSnap());
    if (!game || youId === null) return;
    for (const e of effects) {
      if (e.kind === "banked" && e.seatId === youId && e.gainedM2 >= 1) {
        snacks.push(`+${formatArea(e.gainedM2)} claimed`, "good");
      }
    }
  }

  /**
   * Things you should never miss, from state (they can be caused by other
   * players, so they never arrive as your own effects).
   */
  function observeEvents(snap: SimSnapshot) {
    const youId = youIdOf(snap);
    const name = (id: number) => {
      const s = snap.seats.find((x) => x.id === id);
      return s ? displayName(s, youId) : `Player ${id}`;
    };
    for (const f of snap.feed) {
      if (f.atMs <= seen.feed) continue;
      if (f.reason === "captured") killFeed.push(`${name(f.byId)} took all of ${name(f.victimId)}'s land`, f.victimId === youId ? "bad" : "");
      else killFeed.push(`${name(f.byId)} cut ${name(f.victimId)}`, f.victimId === youId ? "bad" : "");
      if (f.victimId === youId) snacks.push("Respawn — head to your ring", "bad");
      else if (f.byId === youId) snacks.push(f.reason === "captured" ? `You took all of ${name(f.victimId)}'s land!` : `You cut ${name(f.victimId)}!`, "good");
    }
    for (const n of snap.notices) {
      if (n.atMs <= seen.notice) continue;
      if (n.seatId === youId && n.byId !== youId) snacks.push(`${name(n.byId)} took ${formatArea(n.lostM2)} of your land`, "bad");
      else if (n.byId === youId) snacks.push(`You took ${formatArea(n.lostM2)} from ${name(n.seatId)}`, "good");
    }
    for (const p of snap.pops) {
      if (p.atMs <= seen.pop) continue;
      if (p.seatId === youId) snacks.push(seen.pop === 0 ? "You're in — leave your color to draw a trail" : "You're back in!", "good");
    }
    markSeen(snap);
  }

  function markSeen(snap: SimSnapshot | null) {
    const top = (xs: { atMs: number }[]) => xs.reduce((m, x) => Math.max(m, x.atMs), 0);
    if (!snap) return;
    seen = {
      feed: Math.max(seen.feed, top(snap.feed)),
      notice: Math.max(seen.notice, top(snap.notices)),
      pop: Math.max(seen.pop, top(snap.pops)),
    };
  }

  // ---------- navigation ----------
  function show(next: Screen, opts: { push?: boolean } = {}) {
    if (opts.push !== false && next !== screen) history.push(screen);
    screen = next;
    document.querySelectorAll<HTMLElement>(".screen").forEach((el) => {
      el.hidden = el.dataset.screen !== next;
    });
    $("tabs").hidden = !TAB_SCREENS.includes(next);
    const activeTab = next === "player" ? "ranks" : next;
    document.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tab === activeTab);
      if (el.dataset.tab === activeTab) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    const slot = MAP_SLOTS[next];
    if (slot) {
      const snap = currentSnap();
      if (snap) map.update(snap, true);
      map.mount($(slot.slot), slot.camera, snap);
    }
    paintUi(true);
  }

  function back() {
    show(history.pop() ?? "lobby", { push: false });
  }

  /** Tabs are top-level: switching resets the back stack. */
  function openTab(tab: Screen) {
    history.length = 0;
    show(tab, { push: false });
  }

  document.querySelectorAll<HTMLElement>("[data-go]").forEach((el) =>
    el.addEventListener("click", () => show(el.dataset.go as Screen)),
  );
  document.querySelectorAll<HTMLElement>("[data-back]").forEach((el) => el.addEventListener("click", back));
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
    el.addEventListener("click", () => openTab(el.dataset.tab as Screen)),
  );

  // ---------- sign-in ----------
  function applyGoogleUser(user: GoogleUser) {
    profile.signIn = "google";
    if (profile.name === "You" && user.name) profile.name = user.name.slice(0, 20);
    if (!profile.photo && user.photo) profile.photo = user.photo;
    saveProfile(profile);
  }

  const wasSignedIn = profile.signIn !== null;
  const googleUser = await initAuth((user) => {
    if (user) applyGoogleUser(user);
    paintUi(true);
  }).catch(() => null);
  if (googleUser) applyGoogleUser(googleUser);

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
          await signInWithGoogle(); // redirects to Google
        } catch (err) {
          toast(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      profile.signIn = "guest";
      saveProfile(profile);
      show("location");
    }),
  );

  $("btn-signout").addEventListener("click", async () => {
    if (profile.signIn === "google") await signOut().catch(() => undefined);
    profile.signIn = null;
    saveProfile(profile);
    history.length = 0;
    show("intro", { push: false });
  });

  // ---------- location ----------
  const locToggle = $<HTMLInputElement>("loc-toggle");
  const privacyToggle = $<HTMLInputElement>("privacy-loc");
  const locStatus = $("loc-status");

  function getHere(): Promise<LatLon | null> {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 },
      ),
    );
  }

  function setUseLocation(on: boolean) {
    profile.useLocation = on;
    saveProfile(profile);
    locToggle.checked = on;
    privacyToggle.checked = on;
    paintUi(true);
    if (!on) {
      locStatus.textContent = "Location is off: you can watch and play Simulation, but not real-GPS games.";
      return;
    }
    if (!navigator.geolocation) {
      locStatus.textContent = "Location isn't available in this browser.";
      return;
    }
    locStatus.textContent = "Finding you…";
    void getHere().then((p) => {
      if (!p) {
        locStatus.textContent = "Couldn't get your location. Allow location access in your browser to play.";
        return;
      }
      const d = haversineM(p.lat, p.lon, KELLER.lat, KELLER.lon);
      locStatus.textContent =
        d <= 1000 ? "You're near Keller Hall. Ready to claim!" : `Got you — ${formatDist(d)} from Keller Hall. New games center on you.`;
    });
  }
  locToggle.checked = profile.useLocation;
  privacyToggle.checked = profile.useLocation;
  locToggle.addEventListener("change", () => setUseLocation(locToggle.checked));
  privacyToggle.addEventListener("change", () => setUseLocation(privacyToggle.checked));
  $("place-keller").addEventListener("click", () => openTab("lobby"));

  // ---------- Create ----------
  function paintCreate() {
    const pick = (attr: string, val: number) =>
      document.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach((el) => {
        const on = Number(el.dataset[attr]) === val;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", String(on));
      });
    pick("zone", createOpts.zoneFt);
    pick("max", createOpts.max);
    pick("mins", createOpts.mins);
    $("bots-row").classList.toggle("hidden", isSim());
    $("create-mode-hint").textContent = isSim()
      ? `Simulation · ${profile.demoSpeed}× — bots fill every spot and you run on autopilot.`
      : "Real GPS — the circle is centered on you. Share the code so friends can join.";
  }
  for (const attr of ["zone", "max", "mins"] as const) {
    document.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach((el) =>
      el.addEventListener("click", () => {
        const v = Number(el.dataset[attr]);
        if (attr === "zone") createOpts.zoneFt = v;
        if (attr === "max") createOpts.max = v;
        if (attr === "mins") createOpts.mins = v;
        paintCreate();
      }),
    );
  }

  $("btn-create").addEventListener("click", () => {
    if (!isSim() && !profile.useLocation) {
      toast("Location is off. Turn it on in Settings › Privacy, or switch to Simulation.");
      return;
    }
    show("create");
  });

  $("btn-create-go").addEventListener("click", async () => {
    const radiusM = createOpts.zoneFt / FT_PER_M;
    const durationMs = createOpts.mins * 60_000;
    if (isSim()) {
      const match = new LocalMatch({
        arena: buildArena({ radiusM }),
        youName: profile.name,
        players: createOpts.max,
        durationMs,
      });
      beginPlay({ kind: "sim", match, startedAt: match.nowMs, startArea: 0 });
      return;
    }
    const btn = $<HTMLButtonElement>("btn-create-go");
    btn.disabled = true;
    try {
      const here = await getHere();
      if (!here) toast("Couldn't get your GPS — centering on Keller Hall.");
      const center = here ?? { lat: KELLER.lat, lon: KELLER.lon };
      await live.create({
        name: profile.name,
        center,
        radiusM,
        maxSeats: createOpts.max,
        fillBots: $<HTMLInputElement>("bots-toggle").checked,
      });
      await live.sendHere(center);
      history.length = 0;
      show("room", { push: false });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Join ----------
  $("btn-join").addEventListener("click", () => show("join"));
  const codeInput = $<HTMLInputElement>("join-code");
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("btn-join-go").addEventListener("click", async () => {
    if (isSim()) {
      toast("Joining a friend needs Real GPS mode (Settings › Game mode).");
      return;
    }
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
      await live.join(code, profile.name);
      const here = await getHere();
      if (here) await live.sendHere(here);
      history.length = 0;
      show("room", { push: false });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Waiting room ----------
  $("btn-room-start").addEventListener("click", async () => {
    try {
      await live.start();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  $("btn-room-leave").addEventListener("click", () => {
    live.leave();
    openTab("lobby");
  });

  // ---------- Play ----------
  function beginPlay(g: Game) {
    game = g;
    paused = false;
    $("btn-pause").textContent = "Pause";
    snacks.reset();
    killFeed.reset();
    seen = { feed: 0, notice: 0, pop: 0 };
    markSeen(currentSnap());
    if (g.kind === "live") live.startTracking();
    history.length = 0;
    show("play", { push: false });
  }

  $("btn-pause").addEventListener("click", () => {
    paused = !paused;
    live.paused = paused;
    $("btn-pause").textContent = paused ? "Resume" : "Pause";
    last = performance.now();
  });
  $("btn-end").addEventListener("click", () => finish());
  $("btn-done").addEventListener("click", () => openTab("lobby"));

  function finish() {
    if (!game) return;
    const snap = currentSnap();
    lastSnap = snap;
    const youId = youIdOf(snap);
    const area = snap?.you?.areaM2 ?? 0;
    const gained = Math.max(0, area - game.startArea);
    const rank = rankOf(snap, youId);
    const playedMs = (snap?.nowMs ?? Date.now()) - game.startedAt;
    if (game.kind === "live") live.leave();
    game = null;
    paused = false;
    live.paused = false;

    profile.gamesPlayed += 1;
    profile.allTimeScoreM2 += gained;
    profile.totalPlayMs += Math.max(0, playedMs);
    profile.bestGameM2 = Math.max(profile.bestGameM2, gained);
    if (rank !== null && (profile.bestRank === null || rank < profile.bestRank)) profile.bestRank = rank;
    if (rank === 1) profile.wins += 1;
    saveProfile(profile);

    $("done-score").textContent = formatArea(area);
    $("done-time").textContent = formatMs(playedMs);
    $("done-rank").textContent = rank
      ? `You finished #${rank} of ${snap?.seats.length ?? 0}`
      : "No land banked. Leave your color and loop back to claim.";
    history.length = 0;
    show("done", { push: false });
  }

  // ---------- ranks → player ----------
  $("rank-list").addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-seat]");
    if (!row) return;
    const id = Number(row.dataset.seat);
    if (id === youIdOf(currentSnap())) {
      openTab("profile");
    } else {
      viewingId = id;
      show("player");
    }
  });

  // ---------- settings ----------
  const nameInput = $<HTMLInputElement>("name-input");
  const saveNameBtn = $<HTMLButtonElement>("btn-save-name");
  nameInput.value = profile.name;
  nameInput.addEventListener("input", () => {
    const v = nameInput.value.trim();
    saveNameBtn.disabled = !v || v === profile.name;
  });
  $("name-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = nameInput.value.trim().slice(0, 20);
    if (!v) return;
    profile.name = v;
    nameInput.value = v;
    saveNameBtn.disabled = true;
    saveProfile(profile);
    toast("Name saved");
    paintUi(true);
  });

  $<HTMLInputElement>("photo-input").addEventListener("change", (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (file) void setPhoto(file);
  });

  /** Downscale so the photo fits comfortably in localStorage. */
  async function setPhoto(file: File) {
    const bitmap = await createImageBitmap(file);
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const s = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
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

  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) =>
    el.addEventListener("click", () => {
      const mode = el.dataset.mode as "gps" | "demo";
      if (mode === profile.mode) return;
      profile.mode = mode;
      saveProfile(profile);
      toast(mode === "demo" ? "Simulation on — Create runs a bot game right here" : "Real GPS on — Create/Join play outside");
      paintUi(true);
    }),
  );

  const speedRange = $<HTMLInputElement>("speed-range");
  speedRange.value = String(profile.demoSpeed);
  speedRange.addEventListener("input", () => {
    profile.demoSpeed = Number(speedRange.value) || 1;
    saveProfile(profile);
    paintUi(true);
  });

  // ---------- painting ----------
  function playNote(snap: SimSnapshot | null): { text: string; warn: boolean } | null {
    const mode = snap?.you?.mode;
    if (mode === "ghost" || (mode === "toPlant" && snap?.you && seen.pop > 0)) {
      return { text: "Respawn — head to your ring", warn: true };
    }
    if (game?.kind === "live") {
      if (live.serverError) return { text: live.serverError, warn: true };
      const gps = live.gps;
      if (gps.kind === "waiting") return { text: "Getting your GPS…", warn: false };
      if (gps.kind === "denied") return { text: "Location permission is blocked. Allow it in your browser settings to play.", warn: true };
      if (gps.kind === "error") return { text: gps.message, warn: true };
      if (live.outside) return { text: "You're outside the dashed circle. This path shows in gray and won't count.", warn: true };
      if (gps.kind === "ok" && gps.accuracyM > 40) {
        return { text: `Weak GPS (±${formatDist(gps.accuracyM)}). Move to open sky; rough fixes are ignored.`, warn: true };
      }
    }
    if (paused) return { text: "Paused.", warn: false };
    if (mode === "joining" || mode === "toPlant") return { text: "Planting your base…", warn: false };
    if (game?.kind === "sim" && snap && snap.nowMs - game.startedAt < 15_000) {
      return { text: "You're on autopilot. Leave your color to draw a trail; loop back to claim.", warn: false };
    }
    return null;
  }

  function paintUi(force = false) {
    const now = performance.now();
    if (!force && now - lastUiPaint < 250) return;
    lastUiPaint = now;

    const snap = currentSnap();
    const you = snap?.you ?? null;
    const youId = you?.id ?? null;
    const youSeat: SeatLike = you ?? { id: -1, nickname: profile.name, color: "#e85d04" };
    const myRank = rankOf(snap, youId);

    if (screen === "lobby") {
      $("lobby-score").textContent = formatArea(profile.allTimeScoreM2);
      $("lobby-rank").textContent = profile.bestRank ? `#${profile.bestRank}` : "–";
      $("lobby-tag").textContent = isSim() ? `Simulation · ${profile.demoSpeed}×` : "Live map";
      const blocked = !isSim() && !profile.useLocation;
      $("claim-blocked").classList.toggle("hidden", !blocked);
      $("btn-create").classList.toggle("disabled", blocked);
      $("btn-join").classList.toggle("disabled", blocked || isSim());
    }

    if (screen === "create") paintCreate();
    if (screen === "join") $("join-sim").classList.toggle("hidden", !isSim());

    if (screen === "room") {
      const p = live.payload;
      $("room-code").textContent = p?.code ?? "——————";
      const seats = snap?.seats ?? [];
      $("room-count").textContent = `Players · ${seats.length}/${p?.maxSeats ?? 8}`;
      $("room-list").innerHTML = seats
        .map(
          (s, i) => `<li class="${s.id === youId ? "me" : ""}">
            <span class="rank-n">${i + 1}</span>
            <span class="avatar sm" style="background:${s.color}">${avatarHtml(s, youId)}</span>
            <span class="rank-name">${escapeHtml(displayName(s, youId))}${s.bot ? " · bot" : ""}</span>
            <span class="rank-score">${i === 0 ? '<span class="host-tag">HOST</span>' : ""}</span>
          </li>`,
        )
        .join("");
      $("btn-room-start").classList.toggle("hidden", !live.isHost);
      $("room-hint").textContent = live.serverError
        ? live.serverError
        : live.isHost
          ? "Start when everyone's in. You'll spawn where you're standing."
          : "Waiting for the host to start…";
    }

    if (screen === "play") {
      $("play-area").textContent = formatArea(you?.areaM2 ?? 0);
      $("play-timer").textContent = formatMs(snap?.remainingMs ?? 0);
      const note = playNote(snap);
      const noteEl = $("play-note");
      noteEl.classList.toggle("hidden", !note);
      noteEl.classList.toggle("warn", !!note?.warn);
      if (note) noteEl.textContent = note.text;
      $("play-mode").textContent = game?.kind === "sim" ? `Simulation ${profile.demoSpeed}×` : `Real GPS · ${snap?.code ?? ""}`;
    }

    if (screen === "ranks") {
      const inGame = !!game;
      $("ranks-sub").innerHTML = inGame
        ? `This game · <strong>${formatMs(snap?.remainingMs ?? 0)}</strong> left`
        : lastSnap
          ? "Your last game"
          : "Play a game to see the leaderboard here.";
      const rows = snap && (inGame || lastSnap) ? ranked(snap) : [];
      $("rank-list").innerHTML = rows.length
        ? rows
            .map(
              (s, i) => `<li data-seat="${s.id}" class="${s.id === youId ? "me" : ""}">
            <span class="rank-n">${i + 1}</span>
            <span class="avatar sm" style="background:${s.color}">${avatarHtml(s, youId)}</span>
            <span class="rank-name">${escapeHtml(displayName(s, youId))}</span>
            <span class="rank-score">${formatArea(s.areaM2)}</span>
          </li>`,
            )
            .join("")
        : `<li class="empty">No games yet. Create one from Home!</li>`;
      $("r-rank").textContent = myRank ? `#${myRank}` : "–";
      $("r-score").textContent = formatArea(you?.areaM2 ?? 0);
      $("r-best").textContent = profile.bestRank ? `#${profile.bestRank}` : "–";
      $("r-total").textContent = formatArea(profile.allTimeScoreM2);
    }

    if (screen === "profile") {
      paintAvatar($("me-avatar"), youSeat, youSeat.id);
      $("saved-name").textContent = profile.name;
      $("account-line").textContent = profile.signIn === "google" ? "Signed in with Google" : "Playing as a guest";
      document.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
        const on = el.dataset.mode === profile.mode;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", String(on));
      });
      $("speed-block").classList.toggle("hidden", !isSim());
      $("speed-value").textContent = `${profile.demoSpeed}×`;
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
        .map(([label, value]) => `<div class="tile"><span class="tile-label">${label}</span><strong>${value}</strong></div>`)
        .join("");
    }

    if (screen === "player" && snap) {
      const seat = snap.seats.find((s) => s.id === viewingId);
      if (seat) {
        paintAvatar($("p-avatar"), seat, youId);
        $("p-name").textContent = displayName(seat, youId);
        const r = rankOf(snap, seat.id);
        $("p-rank").textContent = r ? `#${r}` : "–";
        $("p-score").textContent = formatArea(seat.areaM2);
      }
    }
  }

  // ---------- main loop ----------
  const nameOf = (s: SeatLike) => displayName(s, youIdOf(currentSnap()));

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

    if (game?.kind === "sim") {
      if (!paused) {
        const effects = game.match.advance(dt, profile.demoSpeed);
        if (effects.length) onYourEffects(effects);
      }
      const snap = game.match.snapshot();
      if (screen === "play") {
        observeEvents(snap);
        map.update(snap, true);
      }
      if (game.match.ended) finish();
    } else if (game?.kind === "live" || screen === "room") {
      if (live.version !== lastLiveVersion) {
        lastLiveVersion = live.version;
        const snap = live.snapshot();
        if (snap) {
          if (screen === "play") {
            observeEvents(snap);
            map.update(snap, true);
            map.setOutsideTracks(live.outsideTracks);
          }
          // Host pressed Start → everyone in the room goes to play.
          if (screen === "room" && snap.phase === "live") {
            beginPlay({ kind: "live", startedAt: snap.nowMs, startArea: 0 });
          }
          if (game?.kind === "live" && snap.phase === "ended") finish();
        }
        paintUi(true);
      }
    } else if (screen === "lobby") {
      // Background bots so Home always has a live map.
      attract.advance(dt, 3);
      if (attract.ended) attract = new LocalMatch({ arena: kellerArena, players: 7, durationMs: 60 * 60_000 });
      const snap = attract.snapshot();
      feed.observe(snap, nameOf);
      map.update(snap, false);
    }
    paintUi();
  }

  const firstScreen: Screen = profile.signIn === null ? "intro" : wasSignedIn ? "lobby" : "location";
  history.length = 0;
  show(firstScreen, { push: false });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#c00;padding:2rem;font-family:Manrope,sans-serif">App failed: ${escapeHtml(String(err))}</pre>`;
});
