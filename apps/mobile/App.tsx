import { useCallback, useEffect, useReducer } from "react";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GameScreen } from "./src/screens/GameScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { CreateSetupScreen } from "./src/screens/CreateSetupScreen";
import { JoinScreen } from "./src/screens/JoinScreen";
import { LoadingScreen } from "./src/screens/LoadingScreen";
import { ErrorRecovery } from "./src/screens/ErrorRecovery";
import { api } from "./src/lib/api";
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
      <StatusBar style={state.screen === "cold_start" ? "light" : "dark"} />

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
