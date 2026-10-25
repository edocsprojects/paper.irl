import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api } from "../lib/api";
import { launchMode, type LaunchMode } from "../lib/config";

export type Session = {
  code: string;
  seatId: number;
  nickname: string;
  mode: LaunchMode;
};

type Props = {
  onReady: (session: Session) => void;
};

export function LobbyScreen({ onReady }: Props) {
  const mode = launchMode();
  const [nickname, setNickname] = useState("You");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runHostBots() {
    const created = await api.createLobby();
    const joined = await api.join(created.code, nickname || "You");
    await api.fillBots(created.code, 1);
    await api.start(created.code);
    onReady({
      code: created.code,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
    });
  }

  async function runJoinBots() {
    let lobbyCode = code.trim().toUpperCase();
    if (!lobbyCode) {
      const created = await api.createLobby();
      lobbyCode = created.code;
      await api.fillBots(lobbyCode, 1);
    }
    const joined = await api.join(lobbyCode, nickname || "You");
    const lobby = await api.get(lobbyCode);
    if (lobby.phase === "open") {
      await api.fillBots(lobbyCode, 1).catch(() => undefined);
      await api.start(lobbyCode);
    }
    onReady({
      code: lobbyCode,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
    });
  }

  async function runHuman() {
    if (code.trim()) {
      const lobbyCode = code.trim().toUpperCase();
      const joined = await api.join(lobbyCode, nickname || "You");
      onReady({
        code: lobbyCode,
        seatId: joined.seat.id,
        nickname: joined.seat.nickname,
        mode,
      });
      return;
    }
    const created = await api.createLobby();
    const joined = await api.join(created.code, nickname || "You");
    onReady({
      code: created.code,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
    });
  }

  const title =
    mode === "host-bots"
      ? "Host + 7 bots"
      : mode === "join-bots"
        ? "Join bot lobby"
        : "Human lobby";

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>paper.irl</Text>
      <Text style={styles.kicker}>{title}</Text>
      <Text style={styles.copy}>
        Keller Hall · Android · street map · local server
      </Text>

      <Text style={styles.label}>Nickname</Text>
      <TextInput
        style={styles.input}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="none"
      />

      {mode !== "host-bots" && (
        <>
          <Text style={styles.label}>
            {mode === "join-bots"
              ? "Lobby code (optional)"
              : "Join code (optional)"}
          </Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            placeholder={
              mode === "human" ? "Leave blank to create" : "Blank = create bot lobby"
            }
            placeholderTextColor="#9ca3af"
          />
        </>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        disabled={busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            if (mode === "host-bots") await runHostBots();
            else if (mode === "join-bots") await runJoinBots();
            else await runHuman();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>
            {mode === "host-bots"
              ? "Create & start"
              : mode === "join-bots"
                ? "Join / start bots"
                : code.trim()
                  ? "Join lobby"
                  : "Create lobby"}
          </Text>
        )}
      </Pressable>

      {mode === "human" && !!code.trim() && (
        <Pressable
          style={styles.secondary}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await api.start(code.trim().toUpperCase());
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Text style={styles.secondaryText}>Host: Start match</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f4f5f7",
    padding: 24,
    justifyContent: "center",
  },
  brand: {
    fontSize: 40,
    fontWeight: "800",
    letterSpacing: -0.5,
    color: "#1b1b1b",
  },
  kicker: {
    marginTop: 6,
    color: "#e85d04",
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontSize: 12,
  },
  copy: { marginTop: 8, color: "#6b7280", fontWeight: "600" },
  label: {
    marginTop: 22,
    marginBottom: 6,
    fontWeight: "700",
    color: "#374151",
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontWeight: "600",
    color: "#111",
  },
  btn: {
    marginTop: 28,
    backgroundColor: "#e85d04",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  secondary: { marginTop: 12, alignItems: "center", padding: 10 },
  secondaryText: { color: "#e85d04", fontWeight: "700" },
  error: { marginTop: 12, color: "#b91c1c", fontWeight: "600" },
});
