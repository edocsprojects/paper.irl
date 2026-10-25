import type { Arena } from "./types.js";

/** Kenneth H. Keller Hall, UMN — freeplay MVP boundary. */
export const KELLER = {
  lat: 44.97452,
  lon: -93.23256,
  radiusM: 500,
  pathWidthM: 5,
  starterRadiusM: 22,
} as const;

export function buildKellerArena(): Arena {
  return buildArena();
}

/** Keller-centered freeplay arena; radius configurable (default 500 m). */
export function buildArena(opts?: {
  radiusM?: number;
  centerLat?: number;
  centerLon?: number;
}): Arena {
  const radiusM = Math.max(50, Math.min(5000, opts?.radiusM ?? KELLER.radiusM));
  const centerLat = opts?.centerLat ?? KELLER.lat;
  const centerLon = opts?.centerLon ?? KELLER.lon;
  return {
    id: `keller-freeplay-r${Math.round(radiusM)}`,
    centerLat,
    centerLon,
    radiusM,
    pathWidthM: KELLER.pathWidthM,
    starterRadiusM: KELLER.starterRadiusM,
  };
}
