import { StyleSheet, Text, View } from "react-native";
import { FadeGate } from "../components/FadeGate";
import { fonts } from "../theme/tokens";

type Props = {
  active: boolean;
  mountKey: number;
  n: number | null;
};

export function CountdownOverlay({ active, mountKey, n }: Props) {
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <View style={styles.center}>
        <Text style={styles.n}>{n ?? ""}</Text>
      </View>
    </FadeGate>
  );
}

const styles = StyleSheet.create({
  layer: {
    backgroundColor: "rgba(20,24,28,0.55)",
    zIndex: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { alignItems: "center", justifyContent: "center" },
  n: {
    fontSize: 120,
    fontFamily: fonts.display,
    color: "#f4f6f8",
    letterSpacing: -2,
  },
});
