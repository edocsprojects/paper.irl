import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LayoutChangeEvent, StyleSheet, View } from "react-native";
import type { LobbyPayload, SeatView } from "../lib/api";
import { toLocalM } from "./geoProject";
import { colors } from "../theme/tokens";

type XY = { x: number; y: number };

type Props = {
  lobby: LobbyPayload;
  youId: number;
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function darken(hex: string, amount = 0.32): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amount));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amount));
  const b = Math.max(0, (n & 255) * (1 - amount));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** Segment from (x1,y1)→(x2,y2) in screen space (rotation around midpoint). */
function Segment({
  x1,
  y1,
  x2,
  y2,
  color,
  thickness,
  opacity = 1,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: number;
  opacity?: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.5) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: mx - len / 2,
        top: my - thickness / 2,
        width: len,
        height: thickness,
        backgroundColor: color,
        opacity,
        transform: [{ rotate: `${angle}deg` }],
        borderRadius: thickness / 2,
      }}
    />
  );
}

function ringToLocal(
  ring: { lat: number; lon: number }[],
  originLat: number,
  originLon: number,
): XY[] {
  return ring.map((p) => toLocalM(originLat, originLon, p.lat, p.lon));
}

/**
 * Plain RN play arena — no MapLibre / WebView / street basemap.
 * Camera locked to local player; positions smoothly lerped.
 */
export function ArenaView({ lobby, youId }: Props) {
  const [size, setSize] = useState({ w: 1, h: 1 });
  const display = useRef<Map<number, XY>>(new Map());
  const targets = useRef<Map<number, XY>>(new Map());
  const [, bump] = useState(0);

  const arena = lobby.arena;
  const originLat = arena.centerLat;
  const originLon = arena.centerLon;

  // Push server positions into lerp targets
  useEffect(() => {
    for (const seat of lobby.seats) {
      const p = seat.position ?? seat.respawnAt;
      if (!p) continue;
      targets.current.set(
        seat.id,
        toLocalM(originLat, originLon, p.lat, p.lon),
      );
      if (!display.current.has(seat.id)) {
        display.current.set(seat.id, {
          ...targets.current.get(seat.id)!,
        });
      }
    }
  }, [lobby.seats, originLat, originLon]);

  // rAF lerp loop
  useEffect(() => {
    let alive = true;
    let raf = 0;
    const tick = () => {
      if (!alive) return;
      let moved = false;
      for (const [id, target] of targets.current) {
        const cur = display.current.get(id) ?? { ...target };
        const nx = lerp(cur.x, target.x, 0.18);
        const ny = lerp(cur.y, target.y, 0.18);
        if (Math.abs(nx - cur.x) > 0.01 || Math.abs(ny - cur.y) > 0.01) {
          moved = true;
        }
        display.current.set(id, { x: nx, y: ny });
      }
      if (moved) bump((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const youLocal =
    display.current.get(youId) ??
    targets.current.get(youId) ??
    ({ x: 0, y: 0 } as XY);

  const scale = useMemo(() => {
    const pad = 0.88;
    const half = Math.min(size.w, size.h) / 2;
    return (half * pad) / Math.max(40, arena.radiusM);
  }, [size.w, size.h, arena.radiusM]);

  function toScreen(local: XY): XY {
    // Fixed camera on you: you at center; +y (north) is up → flip y
    return {
      x: size.w / 2 + (local.x - youLocal.x) * scale,
      y: size.h / 2 - (local.y - youLocal.y) * scale,
    };
  }

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ w: width, h: height });
  }

  const boundaryCenter = toScreen({ x: 0, y: 0 });
  const boundaryPx = arena.radiusM * scale * 2;

  return (
    <View style={styles.root} onLayout={onLayout}>
      <View style={styles.wash} />

      {/* Boundary circle */}
      <View
        pointerEvents="none"
        style={[
          styles.boundary,
          {
            left: boundaryCenter.x - boundaryPx / 2,
            top: boundaryCenter.y - boundaryPx / 2,
            width: boundaryPx,
            height: boundaryPx,
            borderRadius: boundaryPx / 2,
          },
        ]}
      />

      {/* Territory fills (centroid blobs) + borders + trails */}
      {lobby.seats.map((seat) => (
        <TerritoryLayers
          key={`t-${seat.id}`}
          seat={seat}
          originLat={originLat}
          originLon={originLon}
          toScreen={toScreen}
          scale={scale}
        />
      ))}

      {/* Players + respawn markers */}
      {lobby.seats.map((seat) => {
        const local = display.current.get(seat.id);
        if (!local) return null;
        const scr = toScreen(local);
        const you = seat.id === youId;
        const r = you ? 10 : 7;
        return (
          <View key={`p-${seat.id}`}>
            {seat.respawnAt ? (
              <MarkerDot
                local={toLocalM(
                  originLat,
                  originLon,
                  seat.respawnAt.lat,
                  seat.respawnAt.lon,
                )}
                toScreen={toScreen}
                color={seat.color}
                you={you}
              />
            ) : null}
            <View
              style={[
                styles.player,
                {
                  left: scr.x - r,
                  top: scr.y - r,
                  width: r * 2,
                  height: r * 2,
                  borderRadius: r,
                  backgroundColor: seat.color,
                  borderWidth: you ? 3 : 2,
                },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

function MarkerDot({
  local,
  toScreen,
  color,
  you,
}: {
  local: XY;
  toScreen: (p: XY) => XY;
  color: string;
  you: boolean;
}) {
  const scr = toScreen(local);
  const r = you ? 9 : 6;
  return (
    <View
      style={{
        position: "absolute",
        left: scr.x - r,
        top: scr.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        backgroundColor: "#fff",
        borderWidth: 3,
        borderColor: color,
      }}
    />
  );
}

function TerritoryLayers({
  seat,
  originLat,
  originLon,
  toScreen,
  scale,
}: {
  seat: SeatView;
  originLat: number;
  originLon: number;
  toScreen: (p: XY) => XY;
  scale: number;
}) {
  const border = darken(seat.color, 0.32);
  const trailThick = Math.max(2, 3.2);
  const borderThick = Math.max(2, 2.8);

  const fills: ReactNode[] = [];
  const borders: ReactNode[] = [];

  seat.owned.forEach((ring, ri) => {
    if (ring.length < 3) return;
    const locals = ringToLocal(ring, originLat, originLon);
    let cx = 0;
    let cy = 0;
    for (const p of locals) {
      cx += p.x;
      cy += p.y;
    }
    cx /= locals.length;
    cy /= locals.length;
    const scrC = toScreen({ x: cx, y: cy });
    // Approximate fill: translucent disc at centroid (paper.io light fill)
    const rPx = Math.max(8, Math.sqrt(seat.areaM2 / Math.PI) * scale * 0.45);
    fills.push(
      <View
        key={`fill-${seat.id}-${ri}`}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: scrC.x - rPx,
          top: scrC.y - rPx,
          width: rPx * 2,
          height: rPx * 2,
          borderRadius: rPx,
          backgroundColor: seat.color,
          opacity: 0.28,
        }}
      />,
    );
    for (let i = 0; i < locals.length; i++) {
      const a = locals[i]!;
      const b = locals[(i + 1) % locals.length]!;
      const sa = toScreen(a);
      const sb = toScreen(b);
      borders.push(
        <Segment
          key={`ob-${seat.id}-${ri}-${i}`}
          x1={sa.x}
          y1={sa.y}
          x2={sb.x}
          y2={sb.y}
          color={border}
          thickness={borderThick}
        />,
      );
    }
  });

  const trailSegs: ReactNode[] = [];
  if (seat.trail.length >= 2) {
    const locals = ringToLocal(seat.trail, originLat, originLon);
    for (let i = 1; i < locals.length; i++) {
      const a = locals[i - 1]!;
      const b = locals[i]!;
      const sa = toScreen(a);
      const sb = toScreen(b);
      trailSegs.push(
        <Segment
          key={`tr-${seat.id}-${i}`}
          x1={sa.x}
          y1={sa.y}
          x2={sb.x}
          y2={sb.y}
          color={border}
          thickness={trailThick}
          opacity={0.95}
        />,
      );
    }
  }

  return (
    <>
      {fills}
      {borders}
      {trailSegs}
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.mapWash,
    overflow: "hidden",
  },
  wash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#cfd8e0",
  },
  boundary: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(20,20,20,0.45)",
    borderStyle: "dashed",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  player: {
    position: "absolute",
    borderColor: "#fff",
  },
});
