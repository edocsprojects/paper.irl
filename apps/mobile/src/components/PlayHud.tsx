import { Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "./BrandMark";
import { colors, fonts } from "../theme/tokens";
import type { SeatView } from "../lib/api";

type Props = {
  code: string;
  remainingMs: number;
  top3: SeatView[];
  paused?: boolean;
  onExit: () => void;
};

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

const TOP_PAD =
  Platform.OS === "ios" ? 54 : (StatusBar.currentHeight ?? 24) + 8;

/** Safe-area top HUD — brand, compact board, code, timer, exit. No overlap. */
export function PlayHud({ code, remainingMs, top3, paused, onExit }: Props) {
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <View style={styles.left}>
          <BrandMark size={18} style={styles.brand} />
          <View style={styles.board}>
            {top3.slice(0, 3).map((s, i) => (
              <View key={s.id} style={styles.row}>
                <Text style={styles.rank}>{i + 1}</Text>
                <View style={[styles.dot, { backgroundColor: s.color }]} />
                <Text style={styles.name} numberOfLines={1}>
                  {s.nickname}
                </Text>
                <Text style={styles.area}>{Math.round(s.areaM2)}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={styles.right}>
          <Text style={styles.timer}>{fmt(remainingMs)}</Text>
          <Text style={styles.code}>{code}</Text>
          {paused ? <Text style={styles.paused}>Paused</Text> : null}
          <Pressable onPress={onExit} hitSlop={10} style={styles.exitBtn}>
            <Text style={styles.exit}>Exit</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingTop: TOP_PAD,
    paddingHorizontal: 12,
    zIndex: 10,
  },
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "flex-start",
  },
  left: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: "68%",
  },
  brand: { marginBottom: 4 },
  board: { gap: 3 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rank: {
    width: 12,
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.muted,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  name: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.ink,
  },
  area: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.muted,
    fontVariant: ["tabular-nums"],
  },
  right: {
    alignItems: "flex-end",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 88,
  },
  timer: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  code: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.4,
  },
  paused: {
    fontFamily: fonts.ui,
    fontSize: 10,
    color: colors.warn,
  },
  exitBtn: { marginTop: 2, paddingVertical: 2 },
  exit: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.accentDeep,
  },
});
