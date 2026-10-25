import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState as RNAppState, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import { api, type LobbyPayload } from "../lib/api";
import { ArenaView } from "../arena/ArenaView";
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
};

function lobbyFp(lobby: LobbyPayload, youId: number): string {
  return lobby.seats
    .map((s) => {
      const p = s.position ?? s.respawnAt;
      return [
        s.id,
        s.mode,
        Math.round(s.areaM2),
        s.trail.length,
        s.owned.length,
        p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : "",
        s.id === youId ? "1" : "0",
      ].join(":");
    })
    .join("|");
}

/**
 * Live play shell — plain RN arena (no MapLibre).
 * Data: HTTP poll GET /lobbies/:code ~1s + GPS/autopilot POSTs (no websocket).
 */
export function GameScreen({ state, session, dispatch }: Props) {
  const lobby = state.lobby;
  const auto = session.mode === "join-bots" || session.mode === "host-bots";
  const failCount = useRef(0);
  const lastFp = useRef("");
  const [nowMs, setNowMs] = useState(() => Date.now());

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
      const fp = `${next.phase}#${lobbyFp(next, session.seatId)}`;
      if (fp === lastFp.current) return;
      lastFp.current = fp;
      dispatch({ type: "LOBBY", lobby: next });
    },
    [dispatch, session.seatId],
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
    const id = setInterval(refresh, auto ? 1500 : 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session.code, auto, pushLobby, dispatch]);

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

  // Host/joiner countdown 3-2-1 then clear
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

  const needSpawn =
    lobby?.phase === "live" &&
    !!you &&
    (you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost");

  useEffect(() => {
    if (auto || !lobby || lobby.phase !== "live" || needSpawn) return;
    if (state.countdown != null) return;
    let sub: Location.LocationSubscription | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status === "granted") {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 1000,
            distanceInterval: 2,
          },
          async (pos) => {
            try {
              const next = await api.fix(session.code, session.seatId, {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracyM: pos.coords.accuracy ?? 10,
                speedMps:
                  pos.coords.speed && pos.coords.speed > 0
                    ? pos.coords.speed
                    : 1.5,
                clientTsMs: Date.now(),
                mock: false,
              });
              pushLobby(next);
            } catch {
              /* ignore */
            }
          },
        );
      } else {
        timer = setInterval(() => {
          api
            .autopilot(session.code, session.seatId)
            .then(pushLobby)
            .catch(() => undefined);
        }, 1000);
      }
    })();

    return () => {
      sub?.remove();
      if (timer) clearInterval(timer);
    };
  }, [
    auto,
    lobby?.phase,
    needSpawn,
    session.code,
    session.seatId,
    pushLobby,
    state.countdown,
  ]);

  useEffect(() => {
    if (!auto || !lobby || lobby.phase !== "live") return;
    if (state.countdown != null) return;
    const id = setInterval(() => {
      api
        .autopilot(session.code, session.seatId)
        .then((next) => {
          pushLobby(next);
          const me = next.seats.find((s) => s.id === session.seatId);
          if (me && me.mode === "safe") {
            dispatch({ type: "SPAWN_CONFIRMED" });
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(id);
  }, [
    auto,
    lobby?.phase,
    session.code,
    session.seatId,
    pushLobby,
    dispatch,
    state.countdown,
  ]);

  async function spawn() {
    if (!you?.respawnAt) return;
    try {
      const at = you.respawnAt;
      const next = await api.fix(session.code, session.seatId, {
        lat: at.lat,
        lon: at.lon,
        accuracyM: 5,
        speedMps: 0,
        clientTsMs: Date.now(),
        mock: true,
      });
      pushLobby(next);
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

  if (state.screen === "lobby_card" || (lobby.phase === "open" && !session.isHost)) {
    return (
      <LobbyCardScreen
        session={session}
        lobby={lobby}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />
    );
  }

  const showSpawn = spawnOverlayVisible(state.screen, auto);
  const showResults = state.screen === "results";
  const showRematch = state.screen === "rematch_waiting";
  const inPlay =
    lobby.phase === "live" ||
    lobby.phase === "ended" ||
    state.screen === "countdown";

  if (!inPlay) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Waiting…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ArenaView lobby={lobby} youId={session.seatId} />

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
