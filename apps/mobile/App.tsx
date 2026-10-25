import { useCallback, useEffect, useReducer, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GameScreen } from "./src/screens/GameScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { CreateSetupScreen } from "./src/screens/CreateSetupScreen";
import { JoinScreen } from "./src/screens/JoinScreen";
import { LoadingScreen } from "./src/screens/LoadingScreen";
import { ErrorRecovery } from "./src/screens/ErrorRecovery";
import { api, TEST_LOCATION } from "./src/lib/api";
import { launchMode } from "./src/lib/config";
import { currentFix } from "./src/lib/location";
import {
  initialAppState,
  reduceApp,
  type LobbyPayload,
  type Session,
} from "./src/state/appMachine";
import { colors } from "./src/theme/tokens";

export default function App() {
  const [state, dispatch] = useReducer(reduceApp, undefined, initialAppState);

  const onBootDone = useCallback(() => {
    dispatch({ type: "BOOT_DONE" });
  }, []);

  useEffect(() => {
    api.health().catch(() => undefined);
  }, []);

  // EXPO_PUBLIC_LAUNCH=host-bots: skip the menus — host a bot match centred
  // on this device's location and start it (Simulator / solo demo).
  const autoHosted = useRef(false);
  useEffect(() => {
    if (state.screen !== "home" || autoHosted.current || launchMode() !== "host-bots") return;
    autoHosted.current = true;
    (async () => {
      try {
        const here = (await currentFix()) ?? TEST_LOCATION;
        // You spawn exactly where your GPS is, but the arena is centred a
        // little away from you so you're one of the crowd, not its hub.
        const radiusM = 250;
        const bearing = Math.random() * Math.PI * 2;
        const off = radiusM * 0.4;
        const centerLat = here.lat + (Math.sin(bearing) * off) / 111320;
        const centerLon =
          here.lon + (Math.cos(bearing) * off) / (111320 * Math.cos((here.lat * Math.PI) / 180));
        const created = await api.createLobby({
          centerLat,
          centerLon,
          radiusM,
          // ≈2.5× a jog (~7 m/s) so a demo shows minutes of play in seconds.
          speedScale: 2.5,
        });
        const joined = await api.join(created.code, "");
        // Tell the server where we stand so our starter spawns right here.
        await api.fix(created.code, joined.seat.id, {
          lat: here.lat,
          lon: here.lon,
          accuracyM: 5,
          speedMps: 0,
          clientTsMs: Date.now(),
          plant: false,
        });
        await api.fillBots(created.code, 1);
        await api.start(created.code);
        const lobby = await api.get(created.code);
        dispatch({
          type: "SESSION_READY",
          session: {
            code: created.code,
            seatId: joined.seat.id,
            nickname: joined.seat.nickname,
            mode: "host-bots",
            isHost: true,
          },
          lobby,
        });
        dispatch({ type: "COUNTDOWN", n: 3 });
      } catch (e) {
        dispatch({ type: "FAIL", error: String(e) });
      }
    })();
  }, [state.screen]);

  function beginCountdown(lobby: LobbyPayload) {
    dispatch({ type: "LOBBY", lobby });
    dispatch({ type: "COUNTDOWN", n: 3 });
  }

  const playScreens = new Set([
    "lobby_card",
    "countdown",
    "match_starting",
    "playing",
    "death_respawn",
    "results",
    "rematch_waiting",
  ]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {state.screen === "cold_start" && <LoadingScreen onDone={onBootDone} />}

      {state.screen === "home" && (
        <HomeScreen
          onCreate={() => dispatch({ type: "OPEN_CREATE" })}
          onJoin={() => dispatch({ type: "OPEN_JOIN" })}
        />
      )}

      {state.screen === "create_setup" && (
        <CreateSetupScreen
          busy={state.connecting}
          onBusy={(v) => dispatch({ type: "SET_CONNECTING", connecting: v })}
          onCreated={(session, lobby) =>
            dispatch({ type: "SESSION_READY", session, lobby })
          }
          onFail={(error) => dispatch({ type: "FAIL", error })}
          onBack={() => dispatch({ type: "EXIT_HOME" })}
        />
      )}

      {state.screen === "join" && (
        <JoinScreen
          busy={state.connecting}
          onBusy={(v) => dispatch({ type: "SET_CONNECTING", connecting: v })}
          onJoined={(session, lobby) => {
            dispatch({ type: "SESSION_READY", session, lobby });
            if (lobby.phase === "live") {
              dispatch({ type: "COUNTDOWN", n: 3 });
            }
          }}
          onFail={(error) => dispatch({ type: "FAIL", error })}
          onBack={() => dispatch({ type: "EXIT_HOME" })}
        />
      )}

      {state.session && playScreens.has(state.screen) && (
        <GameScreen
          state={state}
          session={state.session}
          dispatch={dispatch}
          onHostStarted={beginCountdown}
        />
      )}

      <ErrorRecovery
        active={state.screen === "error"}
        mountKey={state.mountKey}
        message={state.error}
        onRetry={() => {
          dispatch({ type: "RETRY" });
          if (state.session) {
            api
              .get(state.session.code)
              .then((lobby) => dispatch({ type: "LOBBY", lobby }))
              .catch((e) => dispatch({ type: "FAIL", error: String(e) }));
          }
        }}
        onHome={() => dispatch({ type: "EXIT_HOME" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mapWash },
});
