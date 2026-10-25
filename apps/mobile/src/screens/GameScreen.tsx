import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState as RNAppState, Pressable, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import { api, type LobbyPayload } from "../lib/api";
import { GameMap } from "../map/GameMap";
import { SnackbarHost } from "../components/SnackbarHost";
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
import { LobbyWaiting } from "./LobbyWaiting";

type Props = {
  state: AppState;
  session: Session;
  dispatch: (e: AppEvent) => void;
};

export function GameScreen({ state, session, dispatch }: Props) {
  const lobby = state.lobby;
  const auto = session.mode === "join-bots" || session.mode === "host-bots";
  const failCount = useRef(0);

  const you = useMemo(
    () => lobby?.seats.find((s) => s.id === session.seatId) ?? null,
    [lobby, session.seatId],
  );

  const remainingMs = Math.max(
    0,
    (lobby?.endsAtMs ?? Date.now()) - Date.now(),
  );

  const pushLobby = useCallback(
    (next: LobbyPayload) => {
      failCount.current = 0;
      dispatch({ type: "LOBBY", lobby: next });
    },
    [dispatch],
  );

  // Poll lobby
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

  // App background / resume
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

  const needSpawn =
    lobby?.phase === "live" &&
    !!you &&
    (you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost");

  // Human GPS (or mock when denied / emulator) — freeplay fix protocol
  useEffect(() => {
    if (auto || !lobby || lobby.phase !== "live" || needSpawn) return;
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
              /* ignore transient */
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
  ]);

  // Auto-pilot human seat for bot modes
  useEffect(() => {
    if (!auto || !lobby || lobby.phase !== "live") return;
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
  }, [auto, lobby?.phase, session.code, session.seatId, pushLobby, dispatch]);

  async function spawn() {
    if (!you?.respawnAt) return;
    try {
      // Freeplay: plant by sending a fix at the assigned GPS marker.
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
        text: "You're planted — freehand claim inside the circle",
        tone: "good",
      });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  async function startMatch() {
    try {
      await api.start(session.code);
      pushLobby(await api.get(session.code));
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
      dispatch({
        type: "SNACK",
        text: "Rematch — plant at your marker",
        tone: "good",
      });
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

  if (state.screen === "lobby_waiting" || lobby.phase === "open") {
    return (
      <LobbyWaiting
        session={session}
        lobby={lobby}
        onStart={startMatch}
        onExit={() => dispatch({ type: "EXIT_HOME" })}
        busy={state.connecting}
      />
    );
  }

  const showSpawn = spawnOverlayVisible(state.screen, auto);
  const showResults = state.screen === "results";
  const showRematch = state.screen === "rematch_waiting";

  return (
    <View style={styles.root}>
      <GameMap lobby={lobby} youId={session.seatId} remainingMs={remainingMs} />

      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.chip}>
          <Text style={styles.chipText}>{lobby.code}</Text>
        </View>
        {!state.appActive && (
          <View style={[styles.chip, styles.bgChip]}>
            <Text style={styles.chipText}>Paused</Text>
          </View>
        )}
        <Pressable
          style={styles.chip}
          onPress={() => dispatch({ type: "EXIT_HOME" })}
        >
          <Text style={styles.chipText}>Exit</Text>
        </Pressable>
      </View>

      <SnackbarHost
        snack={state.snack}
        onClear={() => dispatch({ type: "CLEAR_SNACK" })}
      />

      <SpawnOverlay
        active={showSpawn}
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
  topBar: {
    position: "absolute",
    top: 48,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  chip: {
    backgroundColor: "rgba(255,255,255,0.94)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line,
  },
  bgChip: { backgroundColor: "rgba(20,20,20,0.85)" },
  chipText: { fontFamily: fonts.ui, color: colors.ink },
});
