import { Platform } from "react-native";
import Constants from "expo-constants";

export type LaunchMode = "human" | "join-bots" | "host-bots";

export function launchMode(): LaunchMode {
  const fromEnv = process.env.EXPO_PUBLIC_LAUNCH as LaunchMode | undefined;
  if (fromEnv === "human" || fromEnv === "join-bots" || fromEnv === "host-bots") {
    return fromEnv;
  }
  const extra = Constants.expoConfig?.extra?.launchMode as string | undefined;
  if (extra === "join-bots" || extra === "host-bots") return extra;
  return "human";
}

/**
 * Default API host for simulators:
 * - Android emulator → host machine via 10.0.2.2
 * - iOS Simulator → host loopback via 127.0.0.1
 * Physical device: set EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3001
 */
export function apiBase(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }
  if (Platform.OS === "ios") {
    return "http://127.0.0.1:3001";
  }
  return "http://10.0.2.2:3001";
}
