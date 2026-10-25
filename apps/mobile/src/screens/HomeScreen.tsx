import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearishBg } from "../components/LinearishBg";
import { BrandMark } from "../components/BrandMark";
import { colors, fonts } from "../theme/tokens";

type Props = {
  onCreate: () => void;
  onJoin: () => void;
};

/** Home: Create | Join only. Brand = paper.irl. */
export function HomeScreen({ onCreate, onJoin }: Props) {
  return (
    <View style={styles.root}>
      <LinearishBg />
      <BrandMark size={48} />
      <Text style={styles.copy}>Claim territory. Walk the circle.</Text>

      <Pressable style={styles.btn} onPress={onCreate}>
        <Text style={styles.btnText}>Create</Text>
      </Pressable>
      <Pressable style={styles.btnSecondary} onPress={onJoin}>
        <Text style={styles.btnSecondaryText}>Join</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 28,
    justifyContent: "center",
  },
  copy: {
    marginTop: 12,
    marginBottom: 36,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontFamily: fonts.ui, fontSize: 18 },
  btnSecondary: {
    marginTop: 12,
    backgroundColor: colors.ink,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnSecondaryText: { color: "#fff", fontFamily: fonts.ui, fontSize: 18 },
});
