import { Pressable, StyleSheet, Text, View } from "react-native";
import { FadeGate } from "../components/FadeGate";
import { BrandMark } from "../components/BrandMark";
import { colors, fonts } from "../theme/tokens";
import { sqft } from "../lib/units";
import type { SeatView } from "../state/appMachine";

type Props = {
  active: boolean;
  mountKey: number;
  top3: SeatView[];
  rematchReadyCount: number;
  rosterSize: number;
  onPlayAgain: () => void;
  onLeave: () => void;
};

export function ResultsOverlay({
  active,
  mountKey,
  top3,
  rematchReadyCount,
  rosterSize,
  onPlayAgain,
  onLeave,
}: Props) {
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <View style={styles.panel}>
        <BrandMark size={28} style={styles.brand} />
        <Text style={styles.kicker}>Lobby ended</Text>
        <Text style={styles.title}>Top 3</Text>
        {top3.map((s, i) => (
          <View key={s.id} style={styles.row}>
            <View style={[styles.swatch, { backgroundColor: s.color }]} />
            <Text style={styles.rank}>{i + 1}</Text>
            <Text style={styles.name}>{s.nickname}</Text>
            <Text style={styles.area}>{sqft(s.areaM2)}</Text>
          </View>
        ))}
        <Pressable style={styles.primary} onPress={onPlayAgain}>
          <Text style={styles.primaryText}>Play again</Text>
        </Pressable>
        <Text style={styles.hint}>
          Same lobby · {rematchReadyCount}/{rosterSize} ready
        </Text>
        <Pressable style={styles.ghost} onPress={onLeave}>
          <Text style={styles.ghostText}>Leave</Text>
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
  brand: { marginBottom: 4 },
  kicker: {
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
  title: {
    marginTop: 4,
    marginBottom: 12,
    fontSize: 28,
    fontFamily: fonts.display,
    color: colors.ink,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  rank: {
    width: 18,
    fontFamily: fonts.ui,
    color: colors.muted,
  },
  name: { flex: 1, fontFamily: fonts.ui, color: colors.ink, fontSize: 16 },
  area: { fontFamily: fonts.body, color: colors.muted },
  primary: {
    marginTop: 22,
    backgroundColor: colors.accent,
    paddingVertical: 13,
    alignItems: "center",
    borderRadius: 4,
  },
  primaryText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
  hint: {
    marginTop: 10,
    textAlign: "center",
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  ghost: { marginTop: 8, padding: 10, alignItems: "center" },
  ghostText: { color: colors.accentDeep, fontFamily: fonts.ui },
});
