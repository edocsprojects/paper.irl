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

/** Android emulator reaches host machine via 10.0.2.2 */
export function apiBase(): string {
  return (
    process.env.EXPO_PUBLIC_API_URL ??
    "http://10.0.2.2:3001"
  );
}
