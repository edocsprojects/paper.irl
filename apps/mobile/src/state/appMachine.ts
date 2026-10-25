/**
 * Mobile UI state machine — screens have explicit enter/leave.
 * Freeplay protocol types match apps/mobile/src/lib/api.ts.
 */

import type { LobbyPayload, SeatView } from "../lib/api";
import type { LaunchMode } from "../lib/config";

export type { LobbyPayload, SeatView };

export type Session = {
  code: string;
  seatId: number;
  nickname: string;
  mode: LaunchMode;
  isHost: boolean;
};

export type UiScreen =
  | "cold_start"
  | "home"
  | "create_setup"
  | "join"
  | "lobby_card"
  | "countdown"
  | "match_starting"
  | "playing"
  | "death_respawn"
  | "results"
  | "rematch_waiting"
  | "error";

export type SnackTone = "neutral" | "good" | "warn" | "bad";

export type AppState = {
  screen: UiScreen;
  resumeScreen: UiScreen | null;
  session: Session | null;
  lobby: LobbyPayload | null;
  error: string | null;
  snack: { id: number; text: string; tone: SnackTone } | null;
  plantedOnce: boolean;
  /** Player tapped Spawn — fixes now plant as soon as they reach the marker. */
  spawnArmed: boolean;
  mountKey: number;
  appActive: boolean;
  connecting: boolean;
  /** 3, 2, 1 during countdown; null otherwise. */
  countdown: number | null;
};

export type AppEvent =
  | { type: "BOOT_DONE" }
  | { type: "OPEN_CREATE" }
  | { type: "OPEN_JOIN" }
  | { type: "SESSION_READY"; session: Session; lobby?: LobbyPayload }
  | { type: "LOBBY"; lobby: LobbyPayload }
  | { type: "COUNTDOWN"; n: number | null }
  | { type: "SNACK"; text: string; tone?: SnackTone }
  | { type: "CLEAR_SNACK" }
  | { type: "SPAWN_ARMED" }
  | { type: "PLAY_AGAIN_READY" }
  | { type: "EXIT_HOME" }
  | { type: "FAIL"; error: string }
  | { type: "CLEAR_ERROR" }
  | { type: "RETRY" }
  | { type: "APP_BG" }
  | { type: "APP_FG" }
  | { type: "SET_CONNECTING"; connecting: boolean };

export function initialAppState(): AppState {
  return {
    screen: "cold_start",
    resumeScreen: null,
    session: null,
    lobby: null,
    error: null,
    snack: null,
    plantedOnce: false,
    spawnArmed: false,
    mountKey: 0,
    appActive: true,
    connecting: false,
    countdown: null,
  };
}

function youOf(state: AppState): SeatView | null {
  if (!state.lobby || !state.session) return null;
  return state.lobby.seats.find((s) => s.id === state.session!.seatId) ?? null;
}

function isAlive(you: SeatView | null): boolean {
  return you?.mode === "safe" || you?.mode === "trailing";
}

function needsPlant(you: SeatView | null, phase: string | undefined): boolean {
  if (phase !== "live" || !you) return false;
  return you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost";
}

export function derivePlayScreen(state: AppState): UiScreen {
  const lobby = state.lobby;
  if (!lobby || !state.session) return "home";
  if (state.countdown != null) return "countdown";
  if (lobby.phase === "open") {
    return "lobby_card";
  }
  if (lobby.phase === "ended") {
    const ready = lobby.rematchReady ?? [];
    if (ready.includes(state.session.seatId)) return "rematch_waiting";
    return "results";
  }
  if (lobby.phase === "live") {
    if (needsPlant(youOf(state), lobby.phase)) {
      return state.plantedOnce ? "death_respawn" : "match_starting";
    }
    return "playing";
  }
  return "lobby_card";
}

function leaveOverlay(state: AppState, next: UiScreen): AppState {
  if (state.screen === next) return state;
  return { ...state, screen: next, mountKey: state.mountKey + 1 };
}

export function reduceApp(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "BOOT_DONE":
      if (state.screen !== "cold_start") return state;
      return leaveOverlay(state, "home");

    case "OPEN_CREATE":
      return leaveOverlay(
        { ...state, session: null, lobby: null, countdown: null, plantedOnce: false, spawnArmed: false },
        "create_setup",
      );

    case "OPEN_JOIN":
      return leaveOverlay(
        { ...state, session: null, lobby: null, countdown: null, plantedOnce: false, spawnArmed: false },
        "join",
      );

    case "SET_CONNECTING":
      return { ...state, connecting: event.connecting };

    case "COUNTDOWN":
      if (event.n == null) {
        const next = { ...state, countdown: null };
        return leaveOverlay(next, derivePlayScreen(next));
      }
      return leaveOverlay({ ...state, countdown: event.n }, "countdown");

    case "SESSION_READY": {
      const next: AppState = {
        ...state,
        session: event.session,
        lobby: event.lobby ?? state.lobby,
        plantedOnce: false,
        spawnArmed: false,
        error: null,
        connecting: false,
      };
      return leaveOverlay(next, derivePlayScreen(next));
    }

    case "LOBBY": {
      const next: AppState = { ...state, lobby: event.lobby, error: null };
      if (!next.session) return next;
      const youNow = youOf(next);
      if (isAlive(youNow)) {
        next.plantedOnce = true;
        next.spawnArmed = false;
      }
      if (state.countdown != null) {
        return { ...next, screen: "countdown" };
      }
      if (state.screen === "rematch_waiting" && event.lobby.phase === "ended") {
        return { ...next, screen: "rematch_waiting" };
      }
      if (event.lobby.phase === "live" && state.lobby?.phase === "ended") {
        next.plantedOnce = false;
        next.spawnArmed = false;
      }
      // Joiner: open → live means host started — enter countdown if not already
      if (
        event.lobby.phase === "live" &&
        state.lobby?.phase === "open" &&
        next.session &&
        !next.session.isHost &&
        state.countdown == null &&
        state.screen !== "countdown"
      ) {
        return leaveOverlay({ ...next, countdown: 3 }, "countdown");
      }
      const derived = derivePlayScreen(next);
      // Human death: snackbar + death_respawn overlay (bots auto-respawn server-side).
      const wasAlive =
        state.screen === "playing" ||
        (state.screen === "countdown" && state.plantedOnce);
      const died =
        derived === "death_respawn" &&
        state.screen !== "death_respawn" &&
        (wasAlive || state.plantedOnce);
      if (died) {
        // No toast: the kill feed shows "Player N cut You" (highlighted) and
        // the death burst + respawn ring explain what to do next.
        next.spawnArmed = false;
      }
      if (derived === state.screen) return next;
      return leaveOverlay(next, derived);
    }

    case "SPAWN_ARMED":
      return { ...state, spawnArmed: true };

    case "PLAY_AGAIN_READY":
      return leaveOverlay(state, "rematch_waiting");

    case "EXIT_HOME":
      return leaveOverlay(
        {
          ...state,
          session: null,
          lobby: null,
          plantedOnce: false,
          spawnArmed: false,
          error: null,
          snack: null,
          countdown: null,
        },
        "home",
      );

    case "FAIL":
      return leaveOverlay(
        { ...state, error: event.error, connecting: false },
        "error",
      );

    case "CLEAR_ERROR":
      if (state.screen !== "error") return { ...state, error: null };
      return leaveOverlay(
        { ...state, error: null },
        state.session ? derivePlayScreen({ ...state, error: null }) : "home",
      );

    case "RETRY": {
      const cleared = { ...state, error: null };
      if (!cleared.session) return leaveOverlay(cleared, "home");
      return leaveOverlay(cleared, derivePlayScreen(cleared));
    }

    case "SNACK":
      return {
        ...state,
        snack: {
          id: (state.snack?.id ?? 0) + 1,
          text: event.text,
          tone: event.tone ?? "neutral",
        },
      };

    case "CLEAR_SNACK":
      return { ...state, snack: null };

    case "APP_BG":
      return {
        ...state,
        appActive: false,
        resumeScreen:
          state.screen === "error" ? state.resumeScreen : state.screen,
      };

    case "APP_FG":
      return { ...state, appActive: true };

    default:
      return state;
  }
}

/**
 * Full tap-to-spawn overlay: match start only, until armed. Respawns need no
 * tap — walk into your respawn ring and you're back in.
 */
export function spawnOverlayVisible(screen: UiScreen, armed: boolean): boolean {
  if (armed) return false;
  return screen === "match_starting";
}
