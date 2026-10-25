/** Equirectangular local meters — mirrors @paper-irl/rules toLocalM. */
export function toLocalM(
  originLat: number,
  originLon: number,
  lat: number,
  lon: number,
): { x: number; y: number } {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lon - originLon) * metersPerDegLon,
    y: (lat - originLat) * metersPerDegLat,
  };
}

export const KELLER_FALLBACK = {
  lat: 44.97452,
  lon: -93.23256,
} as const;

export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
