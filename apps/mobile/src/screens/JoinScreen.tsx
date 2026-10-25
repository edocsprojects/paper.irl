import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BrandMark } from "../components/BrandMark";
import { LinearishBg } from "../components/LinearishBg";
import { api, DEMO_LOBBY_CODE, type LobbyPayload } from "../lib/api";
import { colors, fonts } from "../theme/tokens";
import type { Session } from "../state/appMachine";

type Props = {
  busy: boolean;
  onBusy: (v: boolean) => void;
  onJoined: (session: Session, lobby: LobbyPayload) => void;
  onFail: (error: string) => void;
  onBack: () => void;
};

export function JoinScreen({
  busy,
  onBusy,
  onJoined,
  onFail,
  onBack,
}: Props) {
  const [nickname, setNickname] = useState("You");
  const [code, setCode] = useState(DEMO_LOBBY_CODE);

  async function join() {
    onBusy(true);
    try {
      const lobbyCode = (code.trim() || DEMO_LOBBY_CODE).toUpperCase();
      const joined = await api.join(lobbyCode, nickname.trim() || "You");
      const lobby = await api.get(lobbyCode);
      const hostId = Math.min(...lobby.seats.map((s) => s.id));
      onJoined(
        {
          code: lobbyCode,
          seatId: joined.seat.id,
          nickname: joined.seat.nickname,
          mode: "human",
          isHost: joined.seat.id === hostId,
        },
        lobby,
      );
    } catch (e) {
      onFail(String(e));
    } finally {
      onBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <LinearishBg />
      <View style={styles.top}>
        <BrandMark size={26} />
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      </View>

      <Text style={styles.title}>Join</Text>
      <Text style={styles.copy}>Enter the lobby code from your host.</Text>

      <Text style={styles.label}>Nickname</Text>
      <TextInput
        style={styles.input}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="none"
        placeholderTextColor={colors.muted}
      />

      <Text style={styles.label}>Code</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        placeholder={DEMO_LOBBY_CODE}
        placeholderTextColor={colors.muted}
      />

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        disabled={busy}
        onPress={join}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Join lobby</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24, paddingTop: 56, paddingBottom: 28 },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  back: { color: colors.accentDeep, fontFamily: fonts.ui },
  title: {
    marginTop: 28,
    fontFamily: fonts.display,
    fontSize: 32,
    color: colors.ink,
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
    backgroundColor: colors.ink,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
});
