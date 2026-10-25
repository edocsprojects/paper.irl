import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet } from "react-native";
import { GameScreen } from "./src/screens/GameScreen";
import { LobbyScreen, type Session } from "./src/screens/LobbyScreen";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {session ? (
        <GameScreen session={session} onExit={() => setSession(null)} />
      ) : (
        <LobbyScreen onReady={setSession} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f4f5f7" },
});
