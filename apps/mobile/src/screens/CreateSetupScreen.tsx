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
import { api, TEST_LOCATION, type LobbyPayload } from "../lib/api";
import { formatLatLon } from "../arena/geoProject";
import { colors, fonts } from "../theme/tokens";
import type { Session } from "../state/appMachine";

type Props = {
  busy: boolean;
  onBusy: (v: boolean) => void;
  /** Fired after Create opens a real open lobby (bots filled). */
  onCreated: (session: Session, lobby: LobbyPayload) => void;
  onFail: (error: string) => void;
  onBack: () => void;
};

function parseIntClamped(raw: string, fallback: number, min: number, max: number) {
  const n = Number.parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Config only — Create opens the server lobby (random code + bots).
 * Host presses Start on the lobby card, not here.
 * Everyone auto-sims in play (no Manual / Auto toggle).
 */
export function CreateSetupScreen({
  busy,
  onBusy,
  onCreated,
  onFail,
  onBack,
}: Props) {
  const [nickname, setNickname] = useState("You");
  const [radiusM, setRadiusM] = useState("500");
  const [maxPlayers, setMaxPlayers] = useState("8");
  const lat = TEST_LOCATION.lat;
  const lon = TEST_LOCATION.lon;

  async function create() {
    onBusy(true);
    try {
      const maxSeats = parseIntClamped(maxPlayers, 8, 2, 8);
      const radius = parseIntClamped(radiusM, 500, 50, 5000);
      const created = await api.createLobby({
        maxSeats,
        radiusM: radius,
        centerLat: lat,
        centerLon: lon,
      });
      if (created.phase !== "open") {
        throw new Error("lobby_not_open");
      }
      const joined = await api.join(created.code, nickname.trim() || "You");
      await api.fillBots(created.code, 1);
      const lobby = await api.get(created.code);
      if (lobby.phase !== "open") {
        throw new Error("lobby_not_open");
      }
      onCreated(
        {
          code: created.code,
          seatId: joined.seat.id,
          nickname: joined.seat.nickname,
          mode: "human",
          isHost: true,
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

      <Text style={styles.kicker}>Current location</Text>
      <Text style={styles.coords}>{formatLatLon(lat, lon)}</Text>

      <Text style={styles.label}>Nickname</Text>
      <TextInput
        style={styles.input}
        value={nickname}
        onChangeText={setNickname}
        autoCapitalize="none"
        placeholderTextColor={colors.muted}
      />

      <View style={styles.row}>
        <View style={styles.half}>
          <Text style={styles.label}>Radius (m)</Text>
          <TextInput
            style={styles.input}
            value={radiusM}
            onChangeText={setRadiusM}
            keyboardType="number-pad"
            placeholderTextColor={colors.muted}
          />
        </View>
        <View style={styles.half}>
          <Text style={styles.label}>Max players</Text>
          <TextInput
            style={styles.input}
            value={maxPlayers}
            onChangeText={setMaxPlayers}
            keyboardType="number-pad"
            placeholderTextColor={colors.muted}
          />
        </View>
      </View>

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        disabled={busy}
        onPress={create}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Create</Text>
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
  kicker: {
    marginTop: 28,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  coords: {
    marginTop: 4,
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  label: {
    marginTop: 18,
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
  row: { flexDirection: "row", gap: 12 },
  half: { flex: 1 },
  btn: {
    marginTop: 32,
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 18 },
});
