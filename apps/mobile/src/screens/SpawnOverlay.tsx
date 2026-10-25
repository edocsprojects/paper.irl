import { Pressable, StyleSheet, Text, View } from "react-native";
import { FadeGate } from "../components/FadeGate";
import { colors, fonts } from "../theme/tokens";

type Props = {
  active: boolean;
  mountKey: number;
  wiped: boolean;
  onSpawn: () => void;
};

/**
 * Light tap-to-plant gate (not a cut-error modal).
 * Cut copy lives on the snackbar toast only.
 */
export function SpawnOverlay({ active, mountKey, wiped, onSpawn }: Props) {
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <Pressable style={styles.fill} onPress={onSpawn}>
        <View style={styles.copyBlock}>
          <Text style={styles.kicker}>{wiped ? "Respawn" : "Match start"}</Text>
          <Text style={styles.title}>
            {wiped ? "Back in?" : "Spawn here"}
          </Text>
          <Text style={styles.copy}>
            {wiped
              ? "Your new territory starts right where you're standing."
              : "Your territory starts right where you're standing. Leave it to draw a trail, loop back to claim land."}
          </Text>
          <View style={styles.btn}>
            <Text style={styles.btnText}>
              {wiped ? "Tap to respawn" : "Tap to spawn"}
            </Text>
          </View>
        </View>
      </Pressable>
    </FadeGate>
  );
}

/**
 * Non-blocking message while you are out of the game. Styled like the
 * snackbar; your dashed respawn ring on the map shows where to go.
 */
export function SpawnHint({ text }: { text: string }) {
  return (
    <View style={styles.hintWrap} pointerEvents="none">
      <View style={styles.hint}>
        <Text style={styles.hintText}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hintWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 96,
    alignItems: "center",
    zIndex: 15,
  },
  hint: {
    backgroundColor: "rgba(20,20,20,0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.85)",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
  },
  hintText: {
    color: "#fff",
    fontFamily: fonts.ui,
    fontSize: 14,
    textAlign: "center",
  },
  layer: {
    backgroundColor: "rgba(12,14,16,0.42)",
    zIndex: 20,
  },
  fill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    // Keep the tap control above the bottom SnackbarHost toast.
    paddingBottom: 120,
  },
  copyBlock: {
    alignItems: "center",
    maxWidth: 340,
    marginBottom: 48,
  },
  kicker: {
    color: colors.accent,
    fontFamily: fonts.ui,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    fontSize: 11,
  },
  title: {
    marginTop: 8,
    fontSize: 26,
    fontFamily: fonts.display,
    color: "#f4f6f8",
    letterSpacing: -0.5,
  },
  copy: {
    marginTop: 8,
    textAlign: "center",
    color: "rgba(244,246,248,0.78)",
    fontFamily: fonts.body,
    lineHeight: 20,
    fontSize: 14,
  },
  btn: {
    marginTop: 18,
    backgroundColor: colors.accent,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 4,
  },
  btnText: {
    color: "#fff",
    fontFamily: fonts.ui,
    fontSize: 16,
  },
});
