import { Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "./BrandMark";
import { colors, fonts } from "../theme/tokens";
import type { SeatView } from "../lib/api";
import type { ZoomMode } from "../map/paintPayload";

type Props = {
  remainingMs: number;
  top3: SeatView[];
  youId: number;
  paused?: boolean;
  /** Arena area (m²) so the board shows paper.io-style % held. */
  arenaAreaM2?: number;
  zoomMode: ZoomMode;
  onToggleZoom: () => void;
  onExit: () => void;
};

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function share(areaM2: number, arenaAreaM2?: number): string {
  if (!arenaAreaM2) return String(Math.round(areaM2));
  const pct = (areaM2 / arenaAreaM2) * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Clear of the Dynamic Island / status bar with breathing room. */
export const HUD_TOP =
  Platform.OS === "ios" ? 66 : (StatusBar.currentHeight ?? 24) + 14;
/** Both HUD cards share this height so their tops and bottoms line up. */
export const HUD_HEIGHT = 112;

/** Top HUD: brand + leaderboard (left), timer + zoom + exit (right). */
export function PlayHud({
  remainingMs,
  top3,
  youId,
  paused,
  arenaAreaM2,
  zoomMode,
  onToggleZoom,
  onExit,
}: Props) {
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <View style={[styles.card, styles.left]}>
          <BrandMark size={18} style={styles.brand} />
          <View style={styles.board}>
            {top3.slice(0, 3).map((s, i) => (
              <View key={s.id} style={styles.row}>
                <Text style={styles.rank}>{i + 1}</Text>
                <View style={[styles.dot, { backgroundColor: s.color }]} />
                <Text style={[styles.name, s.id === youId && styles.you]} numberOfLines={1}>
                  {s.id === youId ? `${s.nickname} (You)` : s.nickname}
                </Text>
                <Text style={styles.area}>{share(s.areaM2, arenaAreaM2)}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[styles.card, styles.right]}>
          <Text style={styles.timer}>{fmt(remainingMs)}</Text>
          {paused ? <Text style={styles.paused}>Paused</Text> : null}
          <View style={styles.actions}>
            <Pressable onPress={onToggleZoom} hitSlop={8} style={styles.chip}>
              <Text style={styles.chipText}>{zoomMode === "arena" ? "Zoom in" : "Zoom out"}</Text>
            </Pressable>
            <Pressable onPress={onExit} hitSlop={8} style={[styles.chip, styles.exitChip]}>
              <Text style={[styles.chipText, styles.exitText]}>Leave</Text>
            </Pressable>
          </View>
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
    paddingTop: HUD_TOP,
    paddingHorizontal: 12,
    zIndex: 10,
  },
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  card: {
    height: HUD_HEIGHT,
    backgroundColor: colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  left: { flex: 1, justifyContent: "flex-start" },
  right: { width: 112, alignItems: "flex-end", justifyContent: "space-between" },
  brand: { marginBottom: 6 },
  board: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  rank: { width: 12, fontFamily: fonts.body, fontSize: 11, color: colors.muted },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, fontFamily: fonts.ui, fontSize: 12, color: colors.ink },
  you: { color: colors.accent },
  area: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.muted,
    fontVariant: ["tabular-nums"],
  },
  timer: {
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  paused: { fontFamily: fonts.ui, fontSize: 10, color: colors.warn },
  actions: { alignItems: "flex-end", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chipText: { fontFamily: fonts.ui, fontSize: 12, color: colors.ink },
  exitChip: { backgroundColor: "rgba(239,68,68,0.16)" },
  exitText: { color: colors.danger },
});
