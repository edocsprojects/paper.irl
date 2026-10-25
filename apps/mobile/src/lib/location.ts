import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";

export type GpsFix = {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps: number;
  tsMs: number;
};

export type GpsStatus = "idle" | "asking" | "denied" | "waiting" | "ok" | "error";

export type GpsState = {
  status: GpsStatus;
  fix: GpsFix | null;
  error: string | null;
};

function toFix(loc: Location.LocationObject): GpsFix {
  const c = loc.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    // iOS/Android report -1 / null when unknown.
    accuracyM: c.accuracy != null && c.accuracy >= 0 ? c.accuracy : 25,
    speedMps: c.speed != null && c.speed >= 0 ? c.speed : 0,
    tsMs: loc.timestamp,
  };
}

/** Ask for foreground location once; resolves true when granted. */
export async function ensureLocationPermission(): Promise<boolean> {
  const cur = await Location.getForegroundPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const next = await Location.requestForegroundPermissionsAsync();
  return next.granted;
}

/** One fresh-ish position (for centring a new arena on the host). */
export async function currentFix(): Promise<GpsFix | null> {
  if (!(await ensureLocationPermission())) return null;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 15_000 });
    if (last) return toFix(last);
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    return toFix(loc);
  } catch {
    return null;
  }
}

/**
 * Live GPS stream while `enabled`. `onFix` fires for every new reading
 * (≈1 Hz) — the caller forwards it to the server.
 */
export function useGps(enabled: boolean, onFix?: (fix: GpsFix) => void): GpsState {
  const [state, setState] = useState<GpsState>({ status: "idle", fix: null, error: null });
  const cb = useRef(onFix);
  cb.current = onFix;

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, status: "idle" }));
      return;
    }
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, status: "asking" }));
      const ok = await ensureLocationPermission().catch(() => false);
      if (cancelled) return;
      if (!ok) {
        setState({ status: "denied", fix: null, error: "Location permission denied" });
        return;
      }
      setState((s) => ({ ...s, status: s.fix ? "ok" : "waiting" }));
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 0,
          },
          (loc) => {
            const fix = toFix(loc);
            setState({ status: "ok", fix, error: null });
            cb.current?.(fix);
          },
        );
        if (cancelled) sub.remove();
      } catch (e) {
        if (!cancelled) setState({ status: "error", fix: null, error: String(e) });
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled]);

  return state;
}
