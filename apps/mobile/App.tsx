import { useCallback, useEffect, useReducer } from "react";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { GameScreen } from "./src/screens/GameScreen";
import { LobbyScreen } from "./src/screens/LobbyScreen";
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

  // Warm health check during cold start (non-blocking).
  useEffect(() => {
    api.health().catch(() => undefined);
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style={state.screen === "cold_start" ? "light" : "dark"} />

      {state.screen === "cold_start" && (
        <LoadingScreen onDone={onBootDone} />
      )}

      {state.screen === "home" && (
        <LobbyScreen
          busy={state.connecting}
          onBusy={(v) => dispatch({ type: "SET_CONNECTING", connecting: v })}
          onReady={(session: Session, lobby: LobbyPayload) =>
            dispatch({ type: "SESSION_READY", session, lobby })
          }
          onFail={(error) => dispatch({ type: "FAIL", error })}
        />
      )}

      {state.session &&
        state.screen !== "cold_start" &&
        state.screen !== "home" &&
        state.screen !== "error" && (
          <GameScreen
            state={state}
            session={state.session}
            dispatch={dispatch}
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
