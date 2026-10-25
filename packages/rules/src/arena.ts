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
  return {
    id: "keller-freeplay-v1",
    centerLat: KELLER.lat,
    centerLon: KELLER.lon,
    radiusM: KELLER.radiusM,
    pathWidthM: KELLER.pathWidthM,
    starterRadiusM: KELLER.starterRadiusM,
  };
}
