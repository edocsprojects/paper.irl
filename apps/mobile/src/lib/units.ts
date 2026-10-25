/** Imperial display units. The game itself (server/rules) stays in metres. */
const FT_PER_M = 3.28084;
const FT2_PER_M2 = FT_PER_M * FT_PER_M;

export function feet(m: number): string {
  return `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
}

export function sqft(m2: number): string {
  return `${Math.max(1, Math.round(m2 * FT2_PER_M2)).toLocaleString("en-US")} ft²`;
}

export function feetToMeters(ft: number): number {
  return ft / FT_PER_M;
}

export function metersToFeet(m: number): number {
  return m * FT_PER_M;
}
