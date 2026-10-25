import { StyleSheet, Text, View } from "react-native";
import { HUD_HEIGHT, HUD_TOP } from "./PlayHud";
import { colors, fonts } from "../theme/tokens";
import type { FeedEntry, SeatView } from "../lib/api";
import { seatLabel } from "../lib/names";

type Props = {
  feed: FeedEntry[];
  seats: SeatView[];
  youId: number;
  /** Server clock for the payload (entries fade out after SHOW_MS). */
  nowMs: number;
};

const SHOW_MS = 8000;
const MAX_ROWS = 4;

const TOP = HUD_TOP + HUD_HEIGHT + 10;

const name = seatLabel;

function color(seats: SeatView[], id: number): string {
  return seats.find((s) => s.id === id)?.color ?? colors.muted;
}

/** paper.io-style elimination feed: who got whom, and how. */
export function KillFeed({ feed, seats, youId, nowMs }: Props) {
  const rows = feed.filter((f) => nowMs - f.atMs < SHOW_MS).slice(-MAX_ROWS);
  if (!rows.length) return null;
  return (
    <View style={styles.wrap} pointerEvents="none">
      {rows.map((f) => {
        const victim = name(seats, f.victimId, youId);
        const by = name(seats, f.byId, youId);
        const mine = f.victimId === youId || f.byId === youId;
        return (
          <View key={`${f.atMs}-${f.victimId}`} style={[styles.row, mine && styles.rowMine]}>
            <Dot c={color(seats, f.byId)} />
            <Text style={styles.text} numberOfLines={1}>
              <Text style={styles.strong}>{by}</Text>
              {f.reason === "captured" ? " took all of " : " cut "}
              <Text style={styles.strong}>{victim}</Text>
              {f.reason === "captured" ? "'s land" : ""}
            </Text>
            <Dot c={color(seats, f.victimId)} />
          </View>
        );
      })}
    </View>
  );
}

function Dot({ c }: { c: string }) {
  return <View style={[styles.dot, { backgroundColor: c }]} />;
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: TOP,
    right: 12,
    alignItems: "flex-end",
    gap: 4,
    zIndex: 11,
    maxWidth: "78%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(20,20,20,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
  },
  rowMine: { borderWidth: 1, borderColor: colors.accent },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: "#fff" },
  text: { color: "#fff", fontFamily: fonts.body, fontSize: 12, flexShrink: 1 },
  strong: { fontFamily: fonts.ui },
});
