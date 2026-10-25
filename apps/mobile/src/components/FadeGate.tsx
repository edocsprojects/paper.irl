import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

type Props = {
  /** When false, fades out then unmounts — never leaves a stuck overlay. */
  active: boolean;
  /** Remount key from the state machine (prevents double-mount). */
  mountKey: number;
  durationMs?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  onExited?: () => void;
};

/**
 * Single-mount enter/leave gate. Only one instance should wrap a given overlay.
 */
export function FadeGate({
  active,
  mountKey,
  durationMs = 220,
  style,
  children,
  onExited,
}: Props) {
  const [mounted, setMounted] = useState(active);
  const opacity = useRef(new Animated.Value(active ? 1 : 0)).current;
  const lastKey = useRef(mountKey);
  const leaving = useRef(false);

  useEffect(() => {
    if (active) {
      leaving.current = false;
      if (!mounted || lastKey.current !== mountKey) {
        lastKey.current = mountKey;
        setMounted(true);
        opacity.setValue(0);
      }
      Animated.timing(opacity, {
        toValue: 1,
        duration: durationMs,
        useNativeDriver: true,
      }).start();
      return;
    }
    if (!mounted || leaving.current) return;
    leaving.current = true;
    Animated.timing(opacity, {
      toValue: 0,
      duration: durationMs,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      leaving.current = false;
      setMounted(false);
      onExited?.();
    });
  }, [active, mountKey, durationMs, mounted, opacity, onExited]);

  if (!mounted) return null;

  return (
    <Animated.View
      pointerEvents={active ? "auto" : "none"}
      style={[styles.fill, style, { opacity }]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
});
