import { Pressable, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "../components/BrandMark";
import { formatLatLon } from "../arena/geoProject";
import { colors, fonts } from "../theme/tokens";
import type { LobbyPayload, Session } from "../state/appMachine";

type Props = {
  session: Session;
  lobby: LobbyPayload;
  onLeave: () => void;
};

/** Shared lobby facts for joiners — same lat/lon, radius, max, spots as host. */
export function LobbyCardScreen({ session, lobby, onLeave }: Props) {
  const seats = lobby.seats;
  const slots = Array.from({ length: lobby.maxSeats }, (_, i) => seats[i] ?? null);

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <BrandMark size={26} />
        <Pressable onPress={onLeave} hitSlop={12}>
          <Text style={styles.leave}>Leave</Text>
        </Pressable>
      </View>

      <Text style={styles.kicker}>Lobby {lobby.code}</Text>
      <Text style={styles.coords}>
        {formatLatLon(lobby.arena.centerLat, lobby.arena.centerLon)}
      </Text>
      <Text style={styles.meta}>
        {lobby.arena.radiusM} m · max {lobby.maxSeats}
      </Text>

      <Text style={styles.rosterLabel}>
        Players · {seats.length}/{lobby.maxSeats}
      </Text>
      {slots.map((s, i) =>
        s ? (
          <View key={s.id} style={styles.row}>
            <View style={[styles.dot, { backgroundColor: s.color }]} />
            <Text style={styles.name}>
              {s.nickname}
              {s.id === session.seatId ? " (you)" : ""}
            </Text>
          </View>
        ) : (
          <View key={`e-${i}`} style={styles.row}>
            <View style={[styles.dot, styles.dotEmpty]} />
            <Text style={styles.empty}>Open</Text>
          </View>
        ),
      )}

      <Text style={styles.hint}>Waiting for host to Start…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.mapWash,
    paddingHorizontal: 24,
    paddingTop: 56,
  },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  leave: { color: colors.accentDeep, fontFamily: fonts.ui },
  kicker: {
    marginTop: 28,
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 1,
  },
  coords: {
    marginTop: 8,
    fontFamily: fonts.display,
    fontSize: 24,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  meta: {
    marginTop: 6,
    color: colors.muted,
    fontFamily: fonts.body,
  },
  rosterLabel: {
    marginTop: 28,
    marginBottom: 10,
    fontFamily: fonts.ui,
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotEmpty: { backgroundColor: "rgba(20,20,20,0.15)" },
  name: { fontFamily: fonts.ui, color: colors.ink, fontSize: 16 },
  empty: { fontFamily: fonts.body, color: colors.muted },
  hint: {
    marginTop: 32,
    textAlign: "center",
    color: colors.muted,
    fontFamily: fonts.body,
  },
});
