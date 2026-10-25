import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState as RNAppState, StyleSheet, Text, View } from "react-native";
import {
  api,
  TEST_LOCATION,
  type LobbyPayload,
  type LobbyWithEffects,
} from "../lib/api";
import { snacksFromEffects } from "../lib/effectSnacks";
import { GameMap, mapFingerprint } from "../map/GameMap";
import { SnackbarHost } from "../components/SnackbarHost";
import { PlayHud } from "../components/PlayHud";
import { colors, fonts } from "../theme/tokens";
import {
  spawnOverlayVisible,
  type AppState,
  type AppEvent,
  type Session,
} from "../state/appMachine";
import { SpawnOverlay } from "./SpawnOverlay";
import { ResultsOverlay } from "./ResultsOverlay";
import { RematchWaiting } from "./RematchWaiting";
import { LobbyCardScreen } from "./LobbyCardScreen";
import { CountdownOverlay } from "./CountdownOverlay";

type Props = {
  state: AppState;
  session: Session;
  dispatch: (e: AppEvent) => void;
  onHostStarted: (lobby: LobbyPayload) => void;
};

/**
 * Live play — auto-move only for the local seat (never auto-plant/respawn).
 * Ethan taps Create / Start / respawn. Bots auto-move + auto-respawn on server.
 */
export function GameScreen({
  state,
  session,
  dispatch,
  onHostStarted,
}: Props) {
  const lobby = state.lobby;
  const failCount = useRef(0);
  const lastFp = useRef("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [startBusy, setStartBusy] = useState(false);

  const you = useMemo(
    () => lobby?.seats.find((s) => s.id === session.seatId) ?? null,
    [lobby, session.seatId],
  );

  const remainingMs = Math.max(0, (lobby?.endsAtMs ?? nowMs) - nowMs);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pushLobby = useCallback(
    (next: LobbyPayload) => {
      failCount.current = 0;
      const fp = `${next.phase}#${mapFingerprint(next, session.seatId)}`;
      if (fp === lastFp.current) return;
      lastFp.current = fp;
      dispatch({ type: "LOBBY", lobby: next });
    },
    [dispatch, session.seatId],
  );

  const applyEffects = useCallback(
    (next: LobbyWithEffects) => {
      pushLobby(next);
      for (const snack of snacksFromEffects(
        next.effects,
        session.seatId,
        next,
      )) {
        dispatch({ type: "SNACK", text: snack.text, tone: snack.tone });
      }
    },
    [pushLobby, dispatch, session.seatId],
  );

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await api.get(session.code);
        if (!cancelled) pushLobby(next);
      } catch (e) {
        failCount.current += 1;
        if (!cancelled && failCount.current >= 3) {
          dispatch({ type: "FAIL", error: String(e) });
        }
      }
    }
    refresh();
    const id = setInterval(refresh, 400);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session.code, pushLobby, dispatch]);

  useEffect(() => {
    const sub = RNAppState.addEventListener("change", (next) => {
      if (next === "active") {
        dispatch({ type: "APP_FG" });
        api
          .get(session.code)
          .then(pushLobby)
          .catch((e) => dispatch({ type: "FAIL", error: String(e) }));
      } else if (next === "background" || next === "inactive") {
        dispatch({ type: "APP_BG" });
      }
    });
    return () => sub.remove();
  }, [dispatch, pushLobby, session.code]);

  useEffect(() => {
    if (state.screen !== "countdown" || state.countdown == null) return;
    if (state.countdown <= 0) {
      dispatch({ type: "COUNTDOWN", n: null });
      return;
    }
    const t = setTimeout(() => {
      const next = state.countdown! - 1;
      dispatch({ type: "COUNTDOWN", n: next > 0 ? next : null });
    }, 700);
    return () => clearTimeout(t);
  }, [state.screen, state.countdown, dispatch]);

  // Auto-move only — never autoPlant. Human taps SpawnOverlay to plant/respawn.
  useEffect(() => {
    if (!lobby || lobby.phase !== "live") return;
    if (state.countdown != null) return;
    const id = setInterval(() => {
      api
        .autopilot(session.code, session.seatId, { autoPlant: false })
        .then((next) => {
          applyEffects(next);
        })
        .catch(() => undefined);
    }, 200);
    return () => clearInterval(id);
  }, [
    lobby?.phase,
    session.code,
    session.seatId,
    applyEffects,
    state.countdown,
  ]);

  async function spawn() {
    const at = you?.respawnAt ?? {
      lat: TEST_LOCATION.lat,
      lon: TEST_LOCATION.lon,
    };
    try {
      const next = await api.fix(session.code, session.seatId, {
        lat: at.lat,
        lon: at.lon,
        accuracyM: 5,
        speedMps: 0,
        clientTsMs: Date.now(),
        mock: true,
        plant: true,
      });
      applyEffects(next);
      dispatch({ type: "SPAWN_CONFIRMED" });
      dispatch({
        type: "SNACK",
        text: "You're planted — claim inside the circle",
        tone: "good",
      });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  async function playAgain() {
    try {
      const next = await api.rematchReady(session.code, session.seatId);
      pushLobby(next);
      dispatch({ type: "PLAY_AGAIN_READY" });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  async function startRematch() {
    try {
      const next = await api.rematchStart(session.code, session.seatId);
      pushLobby(next);
      dispatch({ type: "COUNTDOWN", n: 3 });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  if (!lobby) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading lobby…</Text>
      </View>
    );
  }

  if (state.screen === "lobby_card" || lobby.phase === "open") {
    return (
      <LobbyCardScreen
        session={session}
        lobby={lobby}
        busy={startBusy}
        setBusy={setStartBusy}
        onLobby={pushLobby}
        onStarted={onHostStarted}
        onFail={(error) => dispatch({ type: "FAIL", error })}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />
    );
  }

  const showSpawn = spawnOverlayVisible(state.screen, false);
  const showResults = state.screen === "results";
  const showRematch = state.screen === "rematch_waiting";

  return (
    <View style={styles.root}>
      <GameMap lobby={lobby} youId={session.seatId} />

      <PlayHud
        code={lobby.code}
        remainingMs={remainingMs}
        top3={lobby.top3}
        paused={!state.appActive}
        onExit={() => dispatch({ type: "EXIT_HOME" })}
      />

      <SnackbarHost
        snack={state.snack}
        onClear={() => dispatch({ type: "CLEAR_SNACK" })}
      />

      <CountdownOverlay
        active={state.screen === "countdown"}
        mountKey={state.mountKey}
        n={state.countdown}
      />

      <SpawnOverlay
        active={showSpawn && state.screen !== "countdown"}
        mountKey={state.mountKey}
        wiped={state.screen === "death_respawn"}
        onSpawn={spawn}
      />

      <ResultsOverlay
        active={showResults}
        mountKey={state.mountKey}
        top3={lobby.top3}
        rematchReadyCount={(lobby.rematchReady ?? []).length}
        rosterSize={lobby.seats.length}
        onPlayAgain={playAgain}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />

      <RematchWaiting
        active={showRematch}
        mountKey={state.mountKey}
        seats={lobby.seats}
        readyIds={lobby.rematchReady ?? []}
        isHost={session.isHost}
        onStartRematch={startRematch}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mapWash },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: colors.muted, fontFamily: fonts.body },
});
