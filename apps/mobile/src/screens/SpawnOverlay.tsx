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
 * Full-screen spawn gate — tap anywhere (demo preference).
 * Enter/leave via FadeGate; unmounts after leave so it cannot stick.
 */
export function SpawnOverlay({ active, mountKey, wiped, onSpawn }: Props) {
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <Pressable style={styles.fill} onPress={onSpawn}>
        <View style={styles.copyBlock}>
          <Text style={styles.kicker}>{wiped ? "Wiped" : "Match start"}</Text>
          <Text style={styles.title}>
            {wiped ? "You were cut" : "Plant marker"}
          </Text>
          <Text style={styles.copy}>
            {wiped
              ? "Land wiped. Move to your respawn marker, then tap to reload into play."
              : "Run to your marker, then tap anywhere to plant. Others keep playing."}
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
    backgroundColor: colors.overlay,
    zIndex: 20,
  },
  fill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  copyBlock: {
    alignItems: "center",
    maxWidth: 340,
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
    fontSize: 32,
    fontFamily: fonts.display,
    color: "#f4f6f8",
    letterSpacing: -0.5,
  },
  copy: {
    marginTop: 10,
    textAlign: "center",
    color: "rgba(244,246,248,0.78)",
    fontFamily: fonts.body,
    lineHeight: 21,
    fontSize: 15,
  },
  btn: {
    marginTop: 22,
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
