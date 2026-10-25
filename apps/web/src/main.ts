import { buildKellerArena, haversineM, type Effect } from "@paper-irl/rules";
import {
  authReady,
  accessToken,
  initAuth,
  signInWithGoogle,
  signOut,
  type GoogleUser,
} from "./auth.js";
import { CampusSim, type SimSnapshot, type SimSnapshotSeat } from "./botSim.js";
import { LiveGame } from "./liveGame.js";
import { GameMap, type Camera } from "./mapView.js";
import { loadProfile, saveProfile } from "./profile.js";
import "./styles.css";

type Screen = "intro" | "location" | "lobby" | "play" | "done" | "ranks" | "profile" | "player";

const TAB_SCREENS: Screen[] = ["lobby", "ranks", "profile", "player"];

const MAP_SLOTS: Partial<Record<Screen, { slot: string; camera: Camera }>> = {
  lobby: { slot: "slot-lobby", camera: "arena" },
  play: { slot: "slot-play", camera: "follow" },
  done: { slot: "slot-done", camera: "yourLand" },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** m:ss, or h:mm:ss past an hour. */
function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Event countdown: "6d 23:59:59". */
function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => n.toString().padStart(2, "0"))
    .join(":");
  return d ? `${d}d ${hms}` : hms;
}

function formatArea(m2: number): string {
  return `${Math.round(m2).toLocaleString()} m²`;
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

/** Short-lived message list (claim feed on Home, personal snacks while playing). */
class Feed {
  private lastArea = new Map<number, number>();
  constructor(private root: HTMLElement, private max: number) {}

  push(text: string, tone = "") {
    const el = document.createElement("div");
    el.className = `feed-item ${tone}`.trim();
    el.textContent = text;
    this.root.prepend(el);
    while (this.root.children.length > this.max) this.root.lastElementChild?.remove();
    window.setTimeout(() => el.remove(), 6000);
  }

  /** "Bobby just claimed 32 m²!" from area changes between snapshots. */
  observe(snap: SimSnapshot, name: (s: SeatLike) => string) {
    for (const seat of snap.seats) {
      const prev = this.lastArea.get(seat.id);
      this.lastArea.set(seat.id, seat.areaM2);
      if (prev === undefined) continue;
      const delta = seat.areaM2 - prev;
      if (delta >= 1) this.push(`${name(seat)} just claimed ${formatArea(delta)}!`);
      else if (prev > 0 && seat.areaM2 === 0) this.push(`${name(seat)} got cut!`, "bad");
    }
  }

  reset() {
    this.lastArea.clear();
    this.root.innerHTML = "";
  }
}

async function main() {
  const arena = buildKellerArena();
  let sim = new CampusSim(arena);
  const map = await GameMap.create(arena);
  const feed = new Feed($("feed"), 3);
  const snacks = new Feed($("snacks"), 2);
  const live = new LiveGame(
    (): Record<string, string> => {
      const token = accessToken();
      return token ? { Authorization: `Bearer ${token}` } : { "X-Guest-Id": profile.guestId };
    },
    (effects) => onYourEffects(effects, live.payload?.yourSeatId ?? null),
  );

  let screen: Screen = "intro";
  const history: Screen[] = [];
  let paused = false;
  let playing = false;
  let acc = 0;
  let last = performance.now();
  let runStartMs = 0;
  let runStartArea = 0;
  let hasPlanted = false;
  let viewingId = 0;
  let lastUiPaint = 0;
  let lastLiveVersion = -1;

  const isDemo = () => profile.mode === "demo";
  const currentSnap = (): SimSnapshot | null => (isDemo() ? sim.snapshot() : live.snapshot());
  const nowFor = () => (isDemo() ? sim.nowMs : Date.now());

  function displayName(seat: SeatLike, youId: number | null): string {
    return seat.id === youId ? profile.name : seat.nickname;
  }

  function avatarHtml(seat: SeatLike, youId: number | null): string {
    if (seat.id === youId && profile.photo) {
      return `<img src="${escapeHtml(profile.photo)}" alt="" referrerpolicy="no-referrer" />`;
    }
    return escapeHtml(displayName(seat, youId).charAt(0).toUpperCase());
  }

  function paintAvatar(el: HTMLElement, seat: SeatLike, youId: number | null) {
    el.style.background = seat.color;
    el.innerHTML = avatarHtml(seat, youId);
  }

  function onYourEffects(effects: Effect[], youId: number | null) {
    if (!playing || youId === null) return;
    for (const e of effects) {
      if (e.kind === "planted" && e.seatId === youId) {
        hasPlanted = true;
        snacks.push("Base planted — go claim ground", "good");
      }
      if (e.kind === "banked" && e.seatId === youId) snacks.push("Land banked", "good");
      if (e.kind === "cut" && e.victimId === youId) snacks.push("You got cut!", "bad");
      if (e.kind === "cut" && e.byId === youId) snacks.push("You cut someone's trail!", "good");
    }
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
    if (slot) map.mount($(slot.slot), slot.camera, currentSnap());
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
  document.querySelectorAll<HTMLElement>("[data-back]").forEach((el) =>
    el.addEventListener("click", back),
  );
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

  // ---------- location (Frame 4 + Settings › Privacy) ----------
  const locToggle = $<HTMLInputElement>("loc-toggle");
  const privacyToggle = $<HTMLInputElement>("privacy-loc");
  const locStatus = $("loc-status");

  function setUseLocation(on: boolean) {
    profile.useLocation = on;
    saveProfile(profile);
    locToggle.checked = on;
    privacyToggle.checked = on;
    paintUi(true);
    if (!on) {
      locStatus.textContent = "Location is off: you can watch, but you won't be part of the game.";
      return;
    }
    if (!navigator.geolocation) {
      locStatus.textContent = "Location isn't available in this browser.";
      return;
    }
    locStatus.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d = haversineM(
          pos.coords.latitude,
          pos.coords.longitude,
          arena.centerLat,
          arena.centerLon,
        );
        locStatus.textContent =
          d <= arena.radiusM
            ? "You're inside the Keller Hall zone. Ready to claim!"
            : `You're ${(d / 1000).toFixed(1)} km from Keller Hall. Head inside the dashed circle to claim.`;
      },
      () => {
        locStatus.textContent =
          "Couldn't get your location. Allow location access in your browser to play.";
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }
  locToggle.checked = profile.useLocation;
  privacyToggle.checked = profile.useLocation;
  locToggle.addEventListener("change", () => setUseLocation(locToggle.checked));
  privacyToggle.addEventListener("change", () => setUseLocation(privacyToggle.checked));
  $("place-keller").addEventListener("click", () => openTab("lobby"));

  // ---------- run: Frame 2 → 3 → 5 ----------
  $("btn-claim").addEventListener("click", async () => {
    if (!isDemo() && !profile.useLocation) {
      toast("Location is off, so you're not part of the game. Turn it on in Settings › Privacy.");
      return;
    }
    snacks.reset();
    paused = false;
    $("btn-pause").textContent = "Pause";
    if (isDemo()) {
      if (sim.state.phase === "ended") restartDemo();
      sim.youActive = true;
      playing = true;
      runStartMs = sim.nowMs;
      runStartArea = sim.snapshot().you?.areaM2 ?? 0;
      show("play");
      const effects = sim.spawnYou();
      onYourEffects(effects, sim.snapshot().you?.id ?? null);
      return;
    }
    try {
      await live.join(profile.name);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return;
    }
    playing = true;
    runStartMs = Date.now();
    runStartArea = live.snapshot()?.you?.areaM2 ?? 0;
    hasPlanted = (live.snapshot()?.you?.areaM2 ?? 0) > 0;
    live.startTracking();
    show("play");
  });

  $("btn-pause").addEventListener("click", () => {
    paused = !paused;
    live.paused = paused;
    $("btn-pause").textContent = paused ? "Resume" : "Pause";
    last = performance.now();
  });
  $("btn-end").addEventListener("click", finish);
  $("btn-respawn").addEventListener("click", () => {
    onYourEffects(sim.spawnYou(), sim.snapshot().you?.id ?? null);
  });

  $("btn-done").addEventListener("click", () => {
    if (isDemo() && sim.state.phase === "ended") restartDemo();
    openTab("lobby");
  });

  function restartDemo() {
    sim.restart();
    feed.reset();
    snacks.reset();
    hasPlanted = false;
    acc = 0;
    last = performance.now();
  }

  function finish() {
    const snap = currentSnap();
    const youId = snap?.you?.id ?? null;
    const area = snap?.you?.areaM2 ?? 0;
    const gained = Math.max(0, area - runStartArea);
    const rank = rankOf(snap, youId);
    const playedMs = nowFor() - runStartMs;
    if (isDemo()) sim.youActive = false;
    else live.stopTracking();
    playing = false;
    paused = false;
    live.paused = false;

    profile.gamesPlayed += 1;
    profile.allTimeScoreM2 += gained;
    profile.totalPlayMs += playedMs;
    profile.bestGameM2 = Math.max(profile.bestGameM2, gained);
    if (rank !== null && (profile.bestRank === null || rank < profile.bestRank)) {
      profile.bestRank = rank;
    }
    if (rank === 1) profile.wins += 1;
    saveProfile(profile);

    $("done-score").textContent = formatArea(area);
    $("done-time").textContent = formatMs(playedMs);
    $("done-rank").textContent = rank
      ? `+${formatArea(gained)} this run · you're #${rank} in this week's event`
      : "No land banked yet. Loop back to your color to claim.";
    history.length = 0;
    show("done", { push: false });
  }

  // ---------- ranks → player ----------
  $("rank-list").addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-seat]");
    if (!row) return;
    const id = Number(row.dataset.seat);
    if (id === currentSnap()?.you?.id) {
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
    // Rename your seat in the live event if you've joined it.
    if (!isDemo() && live.payload?.yourSeatId != null) void live.join(v).catch(() => undefined);
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
      applyMode();
      toast(mode === "demo" ? "Demo simulation on" : "Real GPS on: you're playing the live event");
    }),
  );

  const speedRange = $<HTMLInputElement>("speed-range");
  speedRange.value = String(profile.demoSpeed);
  speedRange.addEventListener("input", () => {
    profile.demoSpeed = Number(speedRange.value) || 1;
    saveProfile(profile);
    paintUi(true);
  });

  function applyMode() {
    feed.reset();
    lastLiveVersion = -1;
    if (isDemo()) {
      live.stopPolling();
      map.clear();
      map.update(sim.snapshot(), hasPlanted);
    } else {
      map.clear();
      live.startPolling();
    }
    paintUi(true);
  }

  // ---------- painting ----------
  function playNote(snap: SimSnapshot | null): { text: string; warn: boolean } | null {
    if (isDemo()) {
      return sim.nowMs - runStartMs < 20_000
        ? { text: "Demo runner is simulated. Leaving your color opens a trail; loop back to claim.", warn: false }
        : null;
    }
    if (live.serverError) return { text: live.serverError, warn: true };
    const gps = live.gps;
    if (gps.kind === "waiting") return { text: "Getting your GPS…", warn: false };
    if (gps.kind === "denied") {
      return { text: "Location permission is blocked. Allow it in your browser settings to play.", warn: true };
    }
    if (gps.kind === "error") return { text: gps.message, warn: true };
    if (live.outside) {
      return {
        text: "You're outside the dashed circle. This path shows in gray and won't count toward your rank.",
        warn: true,
      };
    }
    if (gps.kind === "ok" && gps.accuracyM > 40) {
      return { text: `Weak GPS (±${Math.round(gps.accuracyM)} m). Move to open sky; rough fixes are ignored.`, warn: true };
    }
    if (paused) return { text: "Paused. Your movement isn't being recorded.", warn: false };
    const mode = snap?.you?.mode;
    if (mode === "joining" || mode === "toPlant") {
      const d = live.markerDistanceM();
      return {
        text: d !== null && d > 20
          ? `Walk to your marker to plant your base (${Math.round(d)} m away).`
          : "Planting your base…",
        warn: false,
      };
    }
    if (mode === "ghost") return { text: "You were cut! You'll get a new marker in a moment.", warn: true };
    if (mode === "trailing") return { text: "Trail open: get back to your color to claim the loop.", warn: false };
    if (mode === "safe") return { text: "You're on your land. Leave your color to start a trail.", warn: false };
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
    const countdown = snap ? formatCountdown(snap.remainingMs) : "–";
    const winner = isDemo() ? null : live.payload?.lastResult?.winner ?? null;

    if (screen === "lobby") {
      $("lobby-score").textContent = formatArea(you?.areaM2 ?? 0);
      $("lobby-rank").textContent = myRank ? `#${myRank}` : "–";
      $("lobby-timer").textContent = countdown;
      const winnerEl = $("lobby-winner");
      winnerEl.classList.toggle("hidden", !winner);
      if (winner) {
        winnerEl.innerHTML = `Last event winner: <strong>${escapeHtml(winner.name)}</strong> · ${formatArea(winner.areaM2)}`;
      }
      $("lobby-tag").textContent = isDemo() ? `Demo simulation · ${profile.demoSpeed}×` : "Live event";
      const alert = $("lobby-alert");
      const err = !isDemo() && live.serverError;
      alert.classList.toggle("hidden", !err);
      if (err) alert.textContent = `${live.serverError}. Start it with: pnpm dev:server`;
      const blocked = !isDemo() && !profile.useLocation;
      $("claim-blocked").classList.toggle("hidden", !blocked);
      $("btn-claim").classList.toggle("disabled", blocked);
    }

    if (screen === "play") {
      $("play-area").textContent = formatArea(you?.areaM2 ?? 0);
      $("play-timer").textContent = formatMs(nowFor() - runStartMs);
      $("btn-respawn").classList.toggle(
        "hidden",
        !(isDemo() && snap?.youNeedSpawn && hasPlanted),
      );
      const note = playNote(snap);
      const noteEl = $("play-note");
      noteEl.classList.toggle("hidden", !note);
      noteEl.classList.toggle("warn", !!note?.warn);
      if (note) noteEl.textContent = note.text;
      $("play-mode").textContent = isDemo() ? `Demo ${profile.demoSpeed}×` : "Real GPS";
    }

    if (screen === "ranks") {
      $("ranks-sub").innerHTML =
        `This week's event ends in <strong>${countdown}</strong>` +
        (winner ? ` · last winner <strong>${escapeHtml(winner.name)}</strong>` : "");
      const rows = snap ? ranked(snap).slice(0, 50) : [];
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
        : `<li class="empty">No one has claimed land yet this week. Be the first!</li>`;
      $("r-rank").textContent = myRank ? `#${myRank}` : "–";
      $("r-score").textContent = formatArea(you?.areaM2 ?? 0);
      $("r-best").textContent = profile.bestRank ? `#${profile.bestRank}` : "–";
      $("r-total").textContent = formatArea(profile.allTimeScoreM2);
    }

    if (screen === "profile") {
      paintAvatar($("me-avatar"), youSeat, youSeat.id);
      $("saved-name").textContent = profile.name;
      $("account-line").textContent =
        profile.signIn === "google" ? "Signed in with Google" : "Playing as a guest";
      document.querySelectorAll<HTMLElement>("[data-mode]").forEach((el) => {
        const on = el.dataset.mode === profile.mode;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", String(on));
      });
      $("speed-block").classList.toggle("hidden", !isDemo());
      $("speed-value").textContent = `${profile.demoSpeed}×`;
      $("privacy-warning").classList.toggle("hidden", profile.useLocation);
      const avg = profile.gamesPlayed ? profile.allTimeScoreM2 / profile.gamesPlayed : 0;
      const stats: [string, string][] = [
        ["All time score", formatArea(profile.allTimeScoreM2)],
        ["Best rank", profile.bestRank ? `#${profile.bestRank}` : "–"],
        ["Runs", String(profile.gamesPlayed)],
        ["Runs ended #1", String(profile.wins)],
        ["Best run", formatArea(profile.bestGameM2)],
        ["Avg per run", formatArea(avg)],
        ["Time played", formatMs(profile.totalPlayMs)],
      ];
      $("stats").innerHTML = stats
        .map(
          ([label, value]) =>
            `<div class="tile"><span class="tile-label">${label}</span><strong>${value}</strong></div>`,
        )
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
  const nameOf = (s: SeatLike) => displayName(s, currentSnap()?.you?.id ?? null);

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
    if (isDemo()) {
      const ticking = !paused && screen !== "intro" && screen !== "location";
      if (ticking && sim.state.phase !== "ended") {
        acc += dt * profile.demoSpeed;
        const effects: Effect[] = [];
        let guard = 0;
        while (acc >= 1 && guard < 40) {
          effects.push(...sim.tickOnce());
          acc -= 1;
          guard++;
        }
        if (effects.length) {
          const snap = sim.snapshot();
          onYourEffects(effects, snap.you?.id ?? null);
          feed.observe(snap, nameOf);
          map.update(snap, hasPlanted || playing);
        }
      } else if (sim.state.phase === "ended") {
        if (playing) finish();
        else if (screen !== "done") restartDemo();
      }
    } else if (live.version !== lastLiveVersion) {
      lastLiveVersion = live.version;
      const snap = live.snapshot();
      if (snap) {
        feed.observe(snap, nameOf);
        map.update(snap, true);
        map.setOutsideTracks(live.outsideTracks);
      }
      paintUi(true);
    }
    paintUi();
  }

  applyMode();
  const firstScreen: Screen =
    profile.signIn === null ? "intro" : wasSignedIn ? "lobby" : "location";
  history.length = 0;
  show(firstScreen, { push: false });
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#c00;padding:2rem;font-family:Manrope,sans-serif">App failed: ${escapeHtml(String(err))}</pre>`;
});
