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
            {wiped ? "Tap to reload" : "Plant marker"}
          </Text>
          <Text style={styles.copy}>
            {wiped
              ? "Move to your marker, then tap to get back in."
              : "Run to your marker, then tap to plant."}
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

const styles = StyleSheet.create({
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
