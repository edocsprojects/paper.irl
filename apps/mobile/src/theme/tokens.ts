import { Platform, TextStyle } from "react-native";

/** Athletic / Strava-adjacent tokens — not purple, not cream brochure. */
export const colors = {
  ink: "#141414",
  inkSoft: "#2a2a2a",
  muted: "#6b7280",
  paper: "#ffffff",
  mapWash: "#dfe5ea",
  line: "rgba(20,20,20,0.08)",
  accent: "#e85d04",
  accentDeep: "#c2410c",
  good: "#166534",
  bad: "#991b1b",
  warn: "#92400e",
  overlay: "rgba(20,24,28,0.42)",
  loadingTop: "#1a2229",
  loadingBottom: "#3d4a55",
} as const;

export const fonts = {
  display: Platform.select({
    ios: "AvenirNext-Heavy",
    android: "sans-serif-black",
    default: "System",
  })!,
  body: Platform.select({
    ios: "AvenirNext-DemiBold",
    android: "sans-serif-medium",
    default: "System",
  })!,
  ui: Platform.select({
    ios: "AvenirNext-Bold",
    android: "sans-serif-medium",
    default: "System",
  })!,
} as const;

export const brandName = "paper.irl" as const;

export const brandText: TextStyle = {
  fontFamily: fonts.display,
  fontSize: 42,
  letterSpacing: -0.8,
  color: colors.ink,
};

export const brandTextOnDark: TextStyle = {
  ...brandText,
  color: "#f4f6f8",
};
