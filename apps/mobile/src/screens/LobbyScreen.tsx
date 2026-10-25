import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearishBg } from "../components/LinearishBg";
import { BrandMark } from "../components/BrandMark";
import { api } from "../lib/api";
import { launchMode } from "../lib/config";
import { colors, fonts } from "../theme/tokens";
import type { LobbyPayload, Session } from "../state/appMachine";

type Props = {
  busy: boolean;
  onBusy: (v: boolean) => void;
  onReady: (session: Session, lobby: LobbyPayload) => void;
  onFail: (error: string) => void;
};

export function LobbyScreen({ busy, onBusy, onReady, onFail }: Props) {
  const mode = launchMode();
  const [nickname, setNickname] = useState("You");
  const [code, setCode] = useState("");

  async function finish(session: Session) {
    const lobby = await api.get(session.code);
    const hostId = Math.min(...lobby.seats.map((s) => s.id));
    onReady({ ...session, isHost: session.seatId === hostId }, lobby);
  }

  async function runHostBots() {
    const created = await api.createLobby();
    const joined = await api.join(created.code, nickname || "You");
    await api.fillBots(created.code, 1);
    await api.start(created.code);
    await finish({
      code: created.code,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
      isHost: true,
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
    await finish({
      code: lobbyCode,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
      isHost: false,
    });
  }

  async function runHuman() {
    if (code.trim()) {
      const lobbyCode = code.trim().toUpperCase();
      const joined = await api.join(lobbyCode, nickname || "You");
      await finish({
        code: lobbyCode,
        seatId: joined.seat.id,
        nickname: joined.seat.nickname,
        mode,
        isHost: false,
      });
      return;
    }
    const created = await api.createLobby();
    const joined = await api.join(created.code, nickname || "You");
    await finish({
      code: created.code,
      seatId: joined.seat.id,
      nickname: joined.seat.nickname,
      mode,
      isHost: true,
    });
  }

  const modeLabel =
    mode === "host-bots"
      ? "Host + bots"
      : mode === "join-bots"
        ? "Join bot lobby"
        : "Create or join";

  return (
    <View style={styles.root}>
      <LinearishBg />
      <BrandMark size={44} />
      <Text style={styles.kicker}>{modeLabel}</Text>
      <Text style={styles.copy}>
        Keller Hall · freeplay GPS · 500 m · max 8
      </Text>

      <Text style={styles.label}>Nickname</Text>
      <TextInput
        style={styles.input}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="none"
        placeholderTextColor={colors.muted}
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
              mode === "human" ? "Blank to create" : "Blank = create bot lobby"
            }
            placeholderTextColor={colors.muted}
          />
        </>
      )}

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        disabled={busy}
        onPress={async () => {
          onBusy(true);
          try {
            if (mode === "host-bots") await runHostBots();
            else if (mode === "join-bots") await runJoinBots();
            else await runHuman();
          } catch (e) {
            onFail(String(e));
          } finally {
            onBusy(false);
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 72,
    paddingBottom: 32,
    justifyContent: "center",
  },
  kicker: {
    marginTop: 10,
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontSize: 12,
  },
  copy: {
    marginTop: 8,
    color: colors.muted,
    fontFamily: fonts.body,
  },
  label: {
    marginTop: 22,
    marginBottom: 6,
    fontFamily: fonts.ui,
    color: colors.inkSoft,
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  btn: {
    marginTop: 28,
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
});
