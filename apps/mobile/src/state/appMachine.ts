/**
 * Mobile UI state machine — screens have explicit enter/leave.
 * Gameplay rules live on the server / @paper-irl/rules; this owns UX only.
 * Freeplay protocol types match apps/mobile/src/lib/api.ts (do not regress).
 */

import type { LobbyPayload, SeatView } from "../lib/api";
import type { LaunchMode } from "../lib/config";

export type { LobbyPayload, SeatView };

export type Session = {
  code: string;
  seatId: number;
  nickname: string;
  mode: LaunchMode;
  /** Lowest seat id in lobby at join time ≈ host for MVP. */
  isHost: boolean;
};

/** Exclusive UI screens — only one primary overlay/screen focus at a time. */
export type UiScreen =
  | "cold_start"
  | "home"
  | "lobby_waiting"
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
  /** Bumps when leaving an overlay so remounts stay single. */
  mountKey: number;
  appActive: boolean;
  connecting: boolean;
};

export type AppEvent =
  | { type: "BOOT_DONE" }
  | { type: "SESSION_READY"; session: Session; lobby?: LobbyPayload }
  | { type: "LOBBY"; lobby: LobbyPayload }
  | { type: "SNACK"; text: string; tone?: SnackTone }
  | { type: "CLEAR_SNACK" }
  | { type: "SPAWN_CONFIRMED" }
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
    mountKey: 0,
    appActive: true,
    connecting: false,
  };
}

function youOf(state: AppState): SeatView | null {
  if (!state.lobby || !state.session) return null;
  return state.lobby.seats.find((s) => s.id === state.session!.seatId) ?? null;
}

function needsPlant(you: SeatView | null, phase: string | undefined): boolean {
  if (phase !== "live" || !you) return false;
  return you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost";
}

/** Map server lobby + seat into a play screen. Overlays never stack. */
export function derivePlayScreen(state: AppState): UiScreen {
  const lobby = state.lobby;
  if (!lobby || !state.session) return "home";
  if (lobby.phase === "open") return "lobby_waiting";
  if (lobby.phase === "ended") {
    const ready = lobby.rematchReady ?? [];
    if (ready.includes(state.session.seatId)) return "rematch_waiting";
    return "results";
  }
  if (lobby.phase === "live") {
    const you = youOf(state);
    if (needsPlant(you, lobby.phase)) {
      return state.plantedOnce ? "death_respawn" : "match_starting";
    }
    return "playing";
  }
  return "lobby_waiting";
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

    case "SET_CONNECTING":
      return { ...state, connecting: event.connecting };

    case "SESSION_READY": {
      const next: AppState = {
        ...state,
        session: event.session,
        lobby: event.lobby ?? state.lobby,
        plantedOnce: false,
        error: null,
        connecting: false,
      };
      return leaveOverlay(next, derivePlayScreen(next));
    }

    case "LOBBY": {
      const next: AppState = { ...state, lobby: event.lobby, error: null };
      if (!next.session) return next;
      if (state.screen === "rematch_waiting" && event.lobby.phase === "ended") {
        return { ...next, screen: "rematch_waiting" };
      }
      // Rematch restart: clear plantedOnce when returning to match_starting.
      if (event.lobby.phase === "live" && state.lobby?.phase === "ended") {
        next.plantedOnce = false;
      }
      const derived = derivePlayScreen(next);
      if (derived === state.screen) return next;
      return leaveOverlay(next, derived);
    }

    case "SPAWN_CONFIRMED": {
      const next = { ...state, plantedOnce: true };
      return leaveOverlay(next, derivePlayScreen(next));
    }

    case "PLAY_AGAIN_READY": {
      if (state.screen !== "results" && state.screen !== "rematch_waiting") {
        return state;
      }
      return leaveOverlay(state, "rematch_waiting");
    }

    case "EXIT_HOME":
      return leaveOverlay(
        {
          ...state,
          session: null,
          lobby: null,
          plantedOnce: false,
          error: null,
          snack: null,
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

export function spawnOverlayVisible(screen: UiScreen, auto: boolean): boolean {
  if (auto) return false;
  return screen === "match_starting" || screen === "death_respawn";
}
