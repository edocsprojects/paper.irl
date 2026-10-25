import { Platform, TextStyle } from "react-native";

/**
 * Permanent dark mode — every surface uses the same charcoal glass as the
 * kill-feed rows (rgba(20,20,20,…)), with white text.
 */
export const colors = {
  ink: "#f3f4f6",
  inkSoft: "#d1d5db",
  muted: "#9ca3af",
  paper: "rgba(20,20,20,0.92)",
  panel: "rgba(20,20,20,0.82)",
  field: "rgba(255,255,255,0.06)",
  mapWash: "#111417",
  line: "rgba(255,255,255,0.08)",
  danger: "#ef4444",
  accent: "#e85d04",
  accentDeep: "#c2410c",
  good: "#166534",
  bad: "#991b1b",
  warn: "#92400e",
  overlay: "rgba(8,10,12,0.6)",
  loadingTop: "#0d1013",
  loadingBottom: "#1b2026",
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
