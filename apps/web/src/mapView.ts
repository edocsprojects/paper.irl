import maplibregl from "maplibre-gl";
import {
  buildTerritoryPaint,
  buildTrailPaint,
  circleRing,
  type Arena,
  type LatLon,
} from "@paper-irl/rules";
import type { SimSnapshot } from "./botSim.js";

/** Free street style (no API key / watermark). */
const STREET_STYLE = "https://tiles.openfreemap.org/styles/bright";
const DEATH_MS = 2400;
const POP_MS = 900;

function darken(hex: string, amount = 0.28): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amount));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amount));
  const b = Math.max(0, (n & 255) * (1 - amount));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function ringCoords(ring: LatLon[]): [number, number][] {
  return ring.map((p) => [p.lon, p.lat]);
}

/** Chaikin corner-cutting so GPS-jagged edges read as soft shapes (visual only). */
function chaikin(pts: [number, number][], closed: boolean, iters = 2): [number, number][] {
  let out = closed ? pts.slice(0, -1) : pts;
  if (out.length < 3) return pts;
  for (let it = 0; it < iters; it++) {
    const next: [number, number][] = closed ? [] : [out[0]!];
    const n = closed ? out.length : out.length - 1;
    for (let i = 0; i < n; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(out[out.length - 1]!);
    out = next;
  }
  if (closed) out.push(out[0]!);
  return out;
}

function territoryGeoJson(snap: SimSnapshot) {
  const fc = buildTerritoryPaint(snap.seats.map((s) => ({ id: s.id, color: s.color, owned: s.owned })));
  return {
    type: "FeatureCollection" as const,
    features: fc.features.map((f) => ({
      type: "Feature" as const,
      properties: {
        fill: f.properties.color,
        border: darken(f.properties.color, 0.32),
        you: f.properties.seatId === snap.you?.id,
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: f.geometry.coordinates.map((r) => chaikin(r, true)),
      },
    })),
  };
}

function trailsGeoJson(snap: SimSnapshot) {
  const fc = buildTrailPaint(
    snap.seats.map((s) => ({
      id: s.id,
      mode: s.mode,
      trail: s.trail,
      position: Number.isFinite(s.lat) ? { lat: s.lat, lon: s.lon } : null,
      color: s.color,
    })),
  );
  return {
    type: "FeatureCollection" as const,
    features: fc.features.map((f) => ({
      type: "Feature" as const,
      properties: { color: f.properties.color, border: darken(f.properties.color, 0.32) },
      geometry: { type: "LineString" as const, coordinates: chaikin(f.geometry.coordinates, false) },
    })),
  };
}

/** Dashed respawn rings: walk into yours and you're back in. */
function spawnGeoJson(snap: SimSnapshot) {
  const r = snap.arena.starterRadiusM;
  const features: GeoJSON.Feature[] = [];
  for (const s of snap.seats) {
    if (!s.respawnAt || !["joining", "toPlant", "ghost"].includes(s.mode)) continue;
    features.push({
      type: "Feature",
      properties: { color: s.color, border: darken(s.color, 0.32), you: s.id === snap.you?.id },
      geometry: { type: "Polygon", coordinates: [ringCoords(circleRing(s.respawnAt, r, 48))] },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function playersGeoJson(snap: SimSnapshot, showYou: boolean) {
  const features: GeoJSON.Feature[] = [];
  const youId = snap.you?.id ?? null;
  for (const seat of snap.seats) {
    const you = seat.id === youId;
    if (you && !showYou) continue;
    if (Number.isFinite(seat.lat) && Number.isFinite(seat.lon)) {
      features.push({
        type: "Feature",
        properties: { color: seat.color, mode: seat.mode, you },
        geometry: { type: "Point", coordinates: [seat.lon, seat.lat] },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function boundaryGeoJson(arena: Arena) {
  const ring = circleRing({ lat: arena.centerLat, lon: arena.centerLon }, arena.radiusM, 96);
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: ringCoords(ring) },
      },
    ],
  };
}

export type Camera = "arena" | "follow" | "yourLand";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** One MapLibre instance, moved between screens' map slots. */
export class GameMap {
  readonly el: HTMLDivElement;
  private map: maplibregl.Map;
  private arena: Arena;
  camera: Camera = "arena";
  private bursts: { atMs: number; lat: number; lon: number; color: string; kind: "death" | "pop" }[] = [];
  private animating = false;

  private constructor(el: HTMLDivElement, map: maplibregl.Map, arena: Arena) {
    this.el = el;
    this.map = map;
    this.arena = arena;
  }

  static async create(arena: Arena): Promise<GameMap> {
    const el = document.createElement("div");
    el.className = "map";
    // MapLibre needs a sized container in the document while it boots.
    el.style.cssText = "position:fixed;left:-9999px;width:400px;height:400px";
    document.body.append(el);
    const map = new maplibregl.Map({
      container: el,
      style: STREET_STYLE,
      center: [arena.centerLon, arena.centerLat],
      zoom: 15.2,
      attributionControl: { compact: true },
    });
    await map.once("load");
    el.style.cssText = "";
    const view = new GameMap(el, map, arena);
    view.addLayers();
    return view;
  }

  private addLayers() {
    const map = this.map;
    map.addSource("boundary", { type: "geojson", data: boundaryGeoJson(this.arena) });
    map.addLayer({
      id: "boundary",
      type: "line",
      source: "boundary",
      paint: {
        "line-color": "#1b1b1b",
        "line-opacity": 0.55,
        "line-width": 2.2,
        "line-dasharray": [2, 1.4],
      },
    });

    map.addSource("owned", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "owned-fill",
      type: "fill",
      source: "owned",
      paint: { "fill-color": ["get", "fill"], "fill-opacity": 0.42 },
    });
    map.addLayer({
      id: "owned-border",
      type: "line",
      source: "owned",
      layout: { "line-join": "round" },
      paint: {
        "line-color": ["get", "border"],
        "line-opacity": 0.95,
        "line-width": ["case", ["get", "you"], 3.6, 2.8],
      },
    });

    // Respawn rings (dashed, tinted) — walk in to plant again.
    map.addSource("spawn", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "spawn-fill",
      type: "fill",
      source: "spawn",
      paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "you"], 0.22, 0.14] },
    });
    map.addLayer({
      id: "spawn-ring",
      type: "line",
      source: "spawn",
      paint: {
        "line-color": ["get", "border"],
        "line-width": ["case", ["get", "you"], 3, 2.2],
        "line-dasharray": [1.4, 1.1],
      },
    });

    // Open trails: player colour over a white casing so they read on any street.
    map.addSource("trails", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "trails-casing",
      type: "line",
      source: "trails",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 7.5, "line-opacity": 0.95 },
    });
    map.addLayer({
      id: "trails",
      type: "line",
      source: "trails",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4.2 },
    });

    // Your path outside the circle: shown, but never sent / scored.
    map.addSource("outside", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "outside",
      type: "line",
      source: "outside",
      paint: {
        "line-color": "#6b7280",
        "line-opacity": 0.85,
        "line-width": 3,
        "line-dasharray": [0.6, 1.4],
      },
    });

    // Death burst / spawn pop.
    map.addSource("bursts", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "bursts",
      type: "circle",
      source: "bursts",
      paint: {
        "circle-radius": ["get", "r"],
        "circle-color": ["get", "fill"],
        "circle-opacity": ["get", "fo"],
        "circle-stroke-width": 3,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-opacity": ["get", "o"],
      },
    });

    map.addSource("players", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "players",
      type: "circle",
      source: "players",
      paint: {
        "circle-radius": ["case", ["get", "you"], 10, 7],
        "circle-color": ["get", "color"],
        "circle-opacity": ["case", ["==", ["get", "mode"], "ghost"], 0.35, 1],
        "circle-stroke-width": ["case", ["get", "you"], 3, 2],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": ["case", ["==", ["get", "mode"], "ghost"], 0.35, 1],
      },
    });
  }

  /** Switch to another game's circle (Create/Join picks the arena). */
  setArena(arena: Arena) {
    if (
      arena.centerLat === this.arena.centerLat &&
      arena.centerLon === this.arena.centerLon &&
      arena.radiusM === this.arena.radiusM
    ) {
      return;
    }
    this.arena = arena;
    (this.map.getSource("boundary") as maplibregl.GeoJSONSource).setData(boundaryGeoJson(arena));
    this.clear();
    if (this.camera === "arena") this.fitArena();
  }

  /** Move the map into a screen's slot and point the camera. */
  mount(slot: HTMLElement, camera: Camera, snap: SimSnapshot | null) {
    if (this.el.parentElement !== slot) slot.prepend(this.el);
    this.camera = camera;
    this.map.resize();
    if (camera === "arena" || !snap) {
      this.fitArena();
    } else if (camera === "yourLand") {
      this.fitYourLand(snap);
    } else {
      this.map.jumpTo({ zoom: 16.4 });
      this.follow(snap, 0);
    }
  }

  private fitArena() {
    const a = this.arena;
    const ring = circleRing({ lat: a.centerLat, lon: a.centerLon }, a.radiusM, 32);
    const b = new maplibregl.LngLatBounds();
    for (const p of ring) b.extend([p.lon, p.lat]);
    this.map.fitBounds(b, { padding: 18, duration: 0, maxZoom: 17.5 });
  }

  clear() {
    for (const id of ["owned", "trails", "spawn", "players", "outside", "bursts"]) {
      (this.map.getSource(id) as maplibregl.GeoJSONSource).setData(EMPTY);
    }
    this.bursts = [];
  }

  update(snap: SimSnapshot, showYou: boolean) {
    this.setArena(snap.arena);
    (this.map.getSource("owned") as maplibregl.GeoJSONSource).setData(territoryGeoJson(snap));
    (this.map.getSource("trails") as maplibregl.GeoJSONSource).setData(trailsGeoJson(snap));
    (this.map.getSource("spawn") as maplibregl.GeoJSONSource).setData(spawnGeoJson(snap));
    (this.map.getSource("players") as maplibregl.GeoJSONSource).setData(playersGeoJson(snap, showYou));
    this.collectBursts(snap);
    if (this.camera === "follow") this.follow(snap, 280);
  }

  private seenBurst = new Set<string>();
  /**
   * New deaths / plants since last update → animated rings on the map.
   * Animated on the real clock (the simulation may run at 20×).
   */
  private collectBursts(snap: SimSnapshot) {
    const colorOf = (id: number) => snap.seats.find((s) => s.id === id)?.color ?? "#111111";
    const realNow = performance.now();
    const add = (key: string, atMs: number, at: LatLon, color: string, kind: "death" | "pop") => {
      if (this.seenBurst.has(key)) return;
      this.seenBurst.add(key);
      // Only animate fresh events (not history replayed when a screen opens).
      if (snap.nowMs - atMs < 1500) this.bursts.push({ atMs: realNow, lat: at.lat, lon: at.lon, color, kind });
    };
    for (const f of snap.feed) {
      if (f.at) add(`d${f.atMs}:${f.victimId}`, f.atMs, f.at, colorOf(f.victimId), "death");
    }
    for (const p of snap.pops) add(`p${p.atMs}:${p.seatId}`, p.atMs, p.at, colorOf(p.seatId), "pop");
    if (!this.bursts.length || this.animating) return;
    this.animating = true;
    const tick = () => {
      const now = performance.now();
      const life = (b: (typeof this.bursts)[number]) => (b.kind === "death" ? DEATH_MS : POP_MS);
      this.bursts = this.bursts.filter((b) => now - b.atMs < life(b));
      const mpp = (156543.03392 * Math.cos((this.arena.centerLat * Math.PI) / 180)) / 2 ** this.map.getZoom();
      (this.map.getSource("bursts") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: this.bursts.map((b) => {
          const k = Math.min(1, Math.max(0, (now - b.atMs) / life(b)));
          const ease = 1 - (1 - k) ** 3;
          const r = b.kind === "death" ? 10 + 40 * ease : ((this.arena.starterRadiusM * 1.1) / mpp) * ease;
          return {
            type: "Feature",
            properties: { r, color: b.color, fill: b.color, o: 1 - k, fo: b.kind === "pop" ? 0.35 * (1 - k) : 0 },
            geometry: { type: "Point", coordinates: [b.lon, b.lat] },
          };
        }),
      });
      if (this.bursts.length) requestAnimationFrame(tick);
      else this.animating = false;
    };
    requestAnimationFrame(tick);
  }

  setOutsideTracks(tracks: LatLon[][]) {
    (this.map.getSource("outside") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: tracks
        .filter((t) => t.length >= 2)
        .map((t) => ({
          type: "Feature" as const,
          properties: {},
          geometry: { type: "LineString" as const, coordinates: ringCoords(t) },
        })),
    });
  }

  private follow(snap: SimSnapshot, duration: number) {
    const you = snap.you;
    if (!you) return;
    const p = Number.isFinite(you.lat) ? you : you.respawnAt;
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    this.map.easeTo({ center: [p.lon, p.lat], duration, essential: true });
  }

  private fitYourLand(snap: SimSnapshot) {
    const pts = snap.you?.owned.flat(2) ?? [];
    if (pts.length < 3) {
      this.fitArena();
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const p of pts) bounds.extend([p.lon, p.lat]);
    this.map.fitBounds(bounds, { padding: 36, maxZoom: 17.5, duration: 0 });
  }
}
