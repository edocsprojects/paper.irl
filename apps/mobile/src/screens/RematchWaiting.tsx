import { Pressable, StyleSheet, Text, View } from "react-native";
import { FadeGate } from "../components/FadeGate";
import { colors, fonts } from "../theme/tokens";
import type { SeatView } from "../state/appMachine";

type Props = {
  active: boolean;
  mountKey: number;
  seats: SeatView[];
  readyIds: number[];
  isHost: boolean;
  onStartRematch: () => void;
  onLeave: () => void;
};

export function RematchWaiting({
  active,
  mountKey,
  seats,
  readyIds,
  isHost,
  onStartRematch,
  onLeave,
}: Props) {
  const ready = new Set(readyIds);
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <View style={styles.panel}>
        <Text style={styles.kicker}>Play again</Text>
        <Text style={styles.title}>Waiting on the lobby</Text>
        <Text style={styles.copy}>
          Same people, same code. Ready seats light up as they rejoin the rematch.
        </Text>
        {seats.map((s) => (
          <View key={s.id} style={styles.row}>
            <View style={[styles.swatch, { backgroundColor: s.color }]} />
            <Text style={styles.name}>{s.nickname}</Text>
            <Text style={[styles.flag, ready.has(s.id) && styles.flagOn]}>
              {ready.has(s.id) ? "Ready" : "…"}
            </Text>
          </View>
        ))}
        {isHost && (
          <Pressable style={styles.primary} onPress={onStartRematch}>
            <Text style={styles.primaryText}>Start rematch</Text>
          </Pressable>
        )}
        {!isHost && (
          <Text style={styles.hint}>Host starts when the squad is ready</Text>
        )}
        <Pressable style={styles.ghost} onPress={onLeave}>
          <Text style={styles.ghostText}>Leave lobby</Text>
        </Pressable>
      </View>
    </FadeGate>
  );
}

const styles = StyleSheet.create({
  layer: {
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 22,
  },
  panel: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.paper,
    padding: 22,
    borderRadius: 4,
  },
  kicker: {
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
  title: {
    marginTop: 6,
    fontSize: 26,
    fontFamily: fonts.display,
    color: colors.ink,
  },
  copy: {
    marginTop: 8,
    marginBottom: 10,
    color: colors.muted,
    fontFamily: fonts.body,
    lineHeight: 20,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  name: { flex: 1, fontFamily: fonts.ui, color: colors.ink },
  flag: { fontFamily: fonts.body, color: colors.muted },
  flagOn: { color: colors.good },
  primary: {
    marginTop: 20,
    backgroundColor: colors.accent,
    paddingVertical: 13,
    alignItems: "center",
    borderRadius: 4,
  },
  primaryText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
  hint: {
    marginTop: 16,
    textAlign: "center",
    color: colors.muted,
    fontFamily: fonts.body,
  },
  ghost: { marginTop: 8, padding: 10, alignItems: "center" },
  ghostText: { color: colors.accentDeep, fontFamily: fonts.ui },
});
