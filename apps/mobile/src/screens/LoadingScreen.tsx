import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BrandMark } from "../components/BrandMark";
import { colors, fonts } from "../theme/tokens";

type Props = {
  onDone: () => void;
  minMs?: number;
};

/** Cold-start / splash — brand-first, full-bleed gradient, brief enter then leave. */
export function LoadingScreen({ onDone, minMs = 900 }: Props) {
  const brand = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0.35)).current;
  const leave = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(brand, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.delay(Math.max(0, minMs - 420 - 280)),
      Animated.timing(leave, {
        toValue: 0,
        duration: 280,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) onDone();
    });

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [brand, leave, minMs, onDone, pulse]);

  return (
    <Animated.View style={[styles.root, { opacity: leave }]}>
      <View style={styles.gradientTop} />
      <View style={styles.gradientBottom} />
      <Animated.View
        style={{
          opacity: brand,
          transform: [
            {
              translateY: brand.interpolate({
                inputRange: [0, 1],
                outputRange: [18, 0],
              }),
            },
          ],
        }}
      >
        <BrandMark onDark size={48} style={styles.brand} />
        <Text style={styles.tag}>freeplay · campus boundary</Text>
      </Animated.View>
      <Animated.View style={[styles.dot, { opacity: pulse }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.loadingTop,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  gradientTop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.loadingTop,
  },
  gradientBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "55%",
    backgroundColor: colors.loadingBottom,
    opacity: 0.85,
  },
  brand: { textAlign: "center" },
  tag: {
    marginTop: 10,
    textAlign: "center",
    color: "rgba(244,246,248,0.72)",
    fontFamily: fonts.body,
    fontSize: 13,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  dot: {
    position: "absolute",
    bottom: 64,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
