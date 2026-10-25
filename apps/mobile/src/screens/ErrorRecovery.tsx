import { Pressable, StyleSheet, Text, View } from "react-native";
import { FadeGate } from "../components/FadeGate";
import { BrandMark } from "../components/BrandMark";
import { colors, fonts } from "../theme/tokens";

type Props = {
  active: boolean;
  mountKey: number;
  message: string | null;
  onRetry: () => void;
  onHome: () => void;
};

export function ErrorRecovery({
  active,
  mountKey,
  message,
  onRetry,
  onHome,
}: Props) {
  return (
    <FadeGate active={active} mountKey={mountKey} style={styles.layer}>
      <View style={styles.panel}>
        <BrandMark size={26} />
        <Text style={styles.kicker}>Connection</Text>
        <Text style={styles.title}>Something dropped</Text>
        <Text style={styles.copy}>{message ?? "Disconnect / server error"}</Text>
        <Pressable style={styles.primary} onPress={onRetry}>
          <Text style={styles.primaryText}>Retry</Text>
        </Pressable>
        <Pressable style={styles.ghost} onPress={onHome}>
          <Text style={styles.ghostText}>Back to lobby setup</Text>
        </Pressable>
      </View>
    </FadeGate>
  );
}

const styles = StyleSheet.create({
  layer: {
    backgroundColor: "rgba(20,24,28,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 40,
  },
  panel: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.paper,
    padding: 22,
    borderRadius: 4,
  },
  kicker: {
    marginTop: 10,
    color: colors.bad,
    fontFamily: fonts.ui,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
  title: {
    marginTop: 6,
    fontSize: 26,
    fontFamily: fonts.display,
    color: colors.ink,
  },
  copy: {
    marginTop: 8,
    color: colors.muted,
    fontFamily: fonts.body,
    lineHeight: 20,
  },
  primary: {
    marginTop: 20,
    backgroundColor: colors.ink,
    paddingVertical: 13,
    alignItems: "center",
    borderRadius: 4,
  },
  primaryText: { color: "#fff", fontFamily: fonts.ui, fontSize: 16 },
  ghost: { marginTop: 8, padding: 10, alignItems: "center" },
  ghostText: { color: colors.accentDeep, fontFamily: fonts.ui },
});
