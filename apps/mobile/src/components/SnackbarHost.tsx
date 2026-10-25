import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FadeGate } from "./FadeGate";
import { colors, fonts } from "../theme/tokens";
import type { SnackTone } from "../state/appMachine";

type Props = {
  snack: { id: number; text: string; tone: SnackTone } | null;
  onClear: () => void;
};

/** How long a toast stays up before fading out. */
const SHOW_MS = 3000;

export function SnackbarHost({ snack, onClear }: Props) {
  // Keyed on the toast id only: the parent re-renders ~4×/s with a fresh
  // onClear, which used to restart this timer forever (toasts never faded).
  const clear = useRef(onClear);
  clear.current = onClear;
  const id = snack?.id;
  useEffect(() => {
    if (id == null) return;
    const t = setTimeout(() => clear.current(), SHOW_MS);
    return () => clearTimeout(t);
  }, [id]);

  return (
    <FadeGate
      active={!!snack}
      mountKey={snack?.id ?? 0}
      style={styles.wrap}
      durationMs={260}
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
    // Above SpawnOverlay (zIndex 20) so cut/planted toasts stay readable.
    zIndex: 40,
    elevation: 40,
  },
  bar: {
    backgroundColor: "rgba(20,20,20,0.88)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    maxWidth: "96%",
  },
  // Dark glass everywhere; tone shows as a coloured edge, not a loud slab.
  good: { borderColor: "rgba(34,197,94,0.7)" },
  bad: { borderColor: "rgba(239,68,68,0.75)" },
  warn: { borderColor: "rgba(245,158,11,0.75)" },
  text: {
    color: "#fff",
    fontFamily: fonts.ui,
    fontSize: 14,
    textAlign: "center",
  },
});
