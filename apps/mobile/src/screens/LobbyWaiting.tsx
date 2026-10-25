import { Pressable, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "../components/BrandMark";
import { colors, fonts } from "../theme/tokens";
import type { LobbyPayload, Session } from "../state/appMachine";

type Props = {
  session: Session;
  lobby: LobbyPayload;
  onStart: () => void;
  onExit: () => void;
  busy?: boolean;
};

/** Open lobby roster — host Start; no late join after Start (server-enforced). */
export function LobbyWaiting({
  session,
  lobby,
  onStart,
  onExit,
  busy,
}: Props) {
  const seats = lobby.seats;
  const canStart = session.isHost || session.mode !== "human";

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <BrandMark size={28} />
        <Pressable onPress={onExit} hitSlop={12}>
          <Text style={styles.exit}>Leave</Text>
        </Pressable>
      </View>
      <Text style={styles.kicker}>Lobby waiting</Text>
      <Text style={styles.code}>{lobby.code}</Text>
      <Text style={styles.copy}>
        {seats.length}/{lobby.maxSeats} players · host starts the match
      </Text>

      <View style={styles.roster}>
        {seats.map((s) => (
          <View key={s.id} style={styles.row}>
            <View style={[styles.swatch, { backgroundColor: s.color }]} />
            <Text style={styles.name}>
              {s.nickname}
              {s.id === session.seatId ? " (you)" : ""}
            </Text>
          </View>
        ))}
        {Array.from({ length: Math.max(0, lobby.maxSeats - seats.length) }).map(
          (_, i) => (
            <View key={`empty-${i}`} style={styles.row}>
              <View style={[styles.swatch, styles.emptySwatch]} />
              <Text style={styles.empty}>Open seat</Text>
            </View>
          ),
        )}
      </View>

      {canStart && (
        <Pressable
          style={[styles.btn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={onStart}
        >
          <Text style={styles.btnText}>Start match</Text>
        </Pressable>
      )}
      {!canStart && (
        <Text style={styles.hint}>Waiting for host to start…</Text>
      )}
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
  exit: { color: colors.accentDeep, fontFamily: fonts.ui },
  kicker: {
    marginTop: 28,
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
  code: {
    marginTop: 6,
    fontSize: 36,
    fontFamily: fonts.display,
    color: colors.ink,
    letterSpacing: 1,
  },
  copy: {
    marginTop: 8,
    color: colors.muted,
    fontFamily: fonts.body,
  },
  roster: { marginTop: 28 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  emptySwatch: { backgroundColor: "rgba(20,20,20,0.12)" },
  name: { fontFamily: fonts.ui, color: colors.ink, fontSize: 16 },
  empty: { fontFamily: fonts.body, color: colors.muted },
  btn: {
    marginTop: 32,
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
  hint: {
    marginTop: 28,
    textAlign: "center",
    color: colors.muted,
    fontFamily: fonts.body,
  },
});
