import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Location from "expo-location";
import { BrandMark } from "../components/BrandMark";
import { LinearishBg } from "../components/LinearishBg";
import { api, DEMO_LOBBY_CODE, type LobbyPayload } from "../lib/api";
import { formatLatLon, KELLER_FALLBACK } from "../arena/geoProject";
import { colors, fonts } from "../theme/tokens";
import type { Session } from "../state/appMachine";

type Props = {
  busy: boolean;
  onBusy: (v: boolean) => void;
  onSession: (session: Session, lobby: LobbyPayload) => void;
  onStarted: (session: Session, lobby: LobbyPayload) => void;
  onFail: (error: string) => void;
  onBack: () => void;
  /** Existing session if lobby already created on this screen. */
  session: Session | null;
  lobby: LobbyPayload | null;
};

function parseIntClamped(raw: string, fallback: number, min: number, max: number) {
  const n = Number.parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * One setup screen: GPS lat/lon (Keller fallback numbers only), radius, max,
 * nickname, roster + ABC123, Start → fill bots + start match.
 */
export function CreateSetupScreen({
  busy,
  onBusy,
  onSession,
  onStarted,
  onFail,
  onBack,
  session,
  lobby,
}: Props) {
  const [nickname, setNickname] = useState("You");
  const [radiusM, setRadiusM] = useState("500");
  const [maxPlayers, setMaxPlayers] = useState("8");
  const [lat, setLat] = useState<number>(KELLER_FALLBACK.lat);
  const [lon, setLon] = useState<number>(KELLER_FALLBACK.lon);
  const [gpsLabel, setGpsLabel] = useState("Locating…");

  // Resolve GPS (Keller numbers only as Simulator fallback), then open ABC123.
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    (async () => {
      onBusy(true);
      let centerLat: number = KELLER_FALLBACK.lat;
      let centerLon: number = KELLER_FALLBACK.lon;
      let label = "Location (Simulator fallback)";
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status === "granted") {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          centerLat = pos.coords.latitude;
          centerLon = pos.coords.longitude;
          label = "Current location";
        }
      } catch {
        /* keep fallback */
      }
      if (cancelled) return;
      setLat(centerLat);
      setLon(centerLon);
      setGpsLabel(label);
      try {
        const maxSeats = parseIntClamped(maxPlayers, 8, 2, 8);
        const radius = parseIntClamped(radiusM, 500, 50, 5000);
        const created = await api.createLobby({
          maxSeats,
          radiusM: radius,
          centerLat,
          centerLon,
        });
        const joined = await api.join(created.code, nickname.trim() || "You");
        const next = await api.get(created.code);
        if (cancelled) return;
        onSession(
          {
            code: created.code,
            seatId: joined.seat.id,
            nickname: joined.seat.nickname,
            mode: "human",
            isHost: true,
          },
          next,
        );
      } catch (e) {
        if (!cancelled) onFail(String(e));
      } finally {
        if (!cancelled) onBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh roster so joiners appear on the same setup screen.
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      api
        .get(session.code)
        .then((next) => onSession(session, next))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(id);
  }, [session, onSession]);

  async function startMatch() {
    if (!session) return;
    onBusy(true);
    try {
      // Keep existing ABC123 roster (joiners stay). Fill bots, then Start.
      await api.fillBots(session.code, 1);
      await api.start(session.code);
      const next = await api.get(session.code);
      onStarted(session, next);
    } catch (e) {
      onFail(String(e));
    } finally {
      onBusy(false);
    }
  }

  const seats = lobby?.seats ?? [];
  const maxSeats = lobby?.maxSeats ?? parseIntClamped(maxPlayers, 8, 2, 8);
  const slots = Array.from({ length: maxSeats }, (_, i) => seats[i] ?? null);

  return (
    <View style={styles.root}>
      <LinearishBg />
      <View style={styles.top}>
        <BrandMark size={26} />
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      </View>

      <Text style={styles.kicker}>{gpsLabel}</Text>
      <Text style={styles.coords}>{formatLatLon(lat, lon)}</Text>
      <Text style={styles.code}>Code {DEMO_LOBBY_CODE}</Text>

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

      <Text style={styles.rosterLabel}>Lobby · {seats.length}/{maxSeats}</Text>
      <View style={styles.roster}>
        {slots.map((s, i) =>
          s ? (
            <View key={s.id} style={styles.spot}>
              <View style={[styles.dot, { backgroundColor: s.color }]} />
              <Text style={styles.spotName} numberOfLines={1}>
                {s.nickname}
              </Text>
            </View>
          ) : (
            <View key={`e-${i}`} style={styles.spot}>
              <View style={[styles.dot, styles.dotEmpty]} />
              <Text style={styles.spotEmpty}>Open</Text>
            </View>
          ),
        )}
      </View>

      <Pressable
        style={[styles.btn, busy && styles.btnDisabled]}
        disabled={busy || !session}
        onPress={startMatch}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Start</Text>
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
    marginTop: 22,
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
  code: {
    marginTop: 6,
    fontFamily: fonts.ui,
    color: colors.accent,
    letterSpacing: 1,
  },
  label: {
    marginTop: 16,
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
  rosterLabel: {
    marginTop: 20,
    marginBottom: 8,
    fontFamily: fonts.ui,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  roster: { gap: 6 },
  spot: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotEmpty: { backgroundColor: "rgba(20,20,20,0.15)" },
  spotName: { fontFamily: fonts.ui, color: colors.ink, flex: 1 },
  spotEmpty: { fontFamily: fonts.body, color: colors.muted },
  btn: {
    marginTop: 28,
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 18 },
});
