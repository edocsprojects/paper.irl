import { StyleSheet, View } from "react-native";
import { colors } from "../theme/tokens";

/** Soft athletic wash without flat single-color void. */
export function LinearishBg() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.base} />
      <View style={styles.band} />
      <View style={styles.glow} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.mapWash,
  },
  band: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "42%",
    backgroundColor: "#cfd8e0",
    opacity: 0.85,
  },
  glow: {
    position: "absolute",
    bottom: -40,
    left: -30,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(232,93,4,0.12)",
  },
});
