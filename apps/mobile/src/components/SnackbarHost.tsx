import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FadeGate } from "./FadeGate";
import { colors, fonts } from "../theme/tokens";
import type { SnackTone } from "../state/appMachine";

type Props = {
  snack: { id: number; text: string; tone: SnackTone } | null;
  onClear: () => void;
};

export function SnackbarHost({ snack, onClear }: Props) {
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(onClear, 3400);
    return () => clearTimeout(t);
  }, [snack, onClear]);

  return (
    <FadeGate
      active={!!snack}
      mountKey={snack?.id ?? 0}
      style={styles.wrap}
      durationMs={180}
    >
      <View
        style={[
          styles.bar,
          snack?.tone === "good" && styles.good,
          snack?.tone === "bad" && styles.bad,
          snack?.tone === "warn" && styles.warn,
        ]}
      >
        <Text style={styles.text}>{snack?.text}</Text>
      </View>
    </FadeGate>
  );
}

const styles = StyleSheet.create({
  wrap: {
    top: undefined,
    bottom: 36,
    left: 16,
    right: 16,
    height: undefined,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  bar: {
    backgroundColor: "rgba(20,20,20,0.92)",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    maxWidth: "96%",
  },
  good: { backgroundColor: "rgba(22,101,52,0.95)" },
  bad: { backgroundColor: "rgba(153,27,27,0.95)" },
  warn: { backgroundColor: "rgba(146,64,14,0.95)" },
  text: {
    color: "#fff",
    fontFamily: fonts.ui,
    fontSize: 14,
    textAlign: "center",
  },
});
