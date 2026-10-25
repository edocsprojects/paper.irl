import maplibregl from "maplibre-gl";
import { circleRing, type Arena, type LatLon } from "@paper-irl/rules";
import type { SimSnapshot } from "./botSim.js";

/** Free street style (no API key / watermark). */
const STREET_STYLE = "https://tiles.openfreemap.org/styles/bright";

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

function ownedGeoJson(snap: SimSnapshot) {
  const features: GeoJSON.Feature[] = [];
  for (const seat of snap.seats) {
    const border = darken(seat.color, 0.32);
    for (const ring of seat.owned) {
      if (ring.length < 3) continue;
      features.push({
        type: "Feature",
        properties: { fill: seat.color, border, kind: "owned" },
        geometry: { type: "Polygon", coordinates: [ringCoords(ring)] },
      });
    }
    if (seat.trail.length >= 2) {
      features.push({
        type: "Feature",
        properties: { fill: seat.color, border, kind: "trail" },
        geometry: { type: "LineString", coordinates: ringCoords(seat.trail) },
      });
    }
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
    if (seat.respawnAt) {
      features.push({
        type: "Feature",
        properties: { color: seat.color, mode: "marker", you },
        geometry: {
          type: "Point",
          coordinates: [seat.respawnAt.lon, seat.respawnAt.lat],
        },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function boundaryGeoJson(arena: Arena) {
  const ring = circleRing(
    { lat: arena.centerLat, lon: arena.centerLon },
    arena.radiusM,
    64,
  );
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

/** One MapLibre instance, moved between screens' map slots. */
export class GameMap {
  readonly el: HTMLDivElement;
  private map: maplibregl.Map;
  private arena: Arena;
  camera: Camera = "arena";

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
      maxBounds: [
        [arena.centerLon - 0.02, arena.centerLat - 0.015],
        [arena.centerLon + 0.02, arena.centerLat + 0.015],
      ],
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

    map.addSource("owned", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "owned-fill",
      type: "fill",
      source: "owned",
      filter: ["==", ["get", "kind"], "owned"],
      paint: { "fill-color": ["get", "fill"], "fill-opacity": 0.38 },
    });
    map.addLayer({
      id: "owned-border",
      type: "line",
      source: "owned",
      filter: ["==", ["get", "kind"], "owned"],
      paint: { "line-color": ["get", "border"], "line-opacity": 0.95, "line-width": 2.8 },
    });
    map.addLayer({
      id: "trails",
      type: "line",
      source: "owned",
      filter: ["==", ["get", "kind"], "trail"],
      paint: {
        "line-color": ["get", "border"],
        "line-opacity": 0.95,
        "line-width": 3.4,
        "line-dasharray": [1.4, 1.1],
      },
    });

    // Your path outside the circle: shown, but never sent / scored.
    map.addSource("outside", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
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

    map.addSource("players", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "markers",
      type: "circle",
      source: "players",
      filter: ["==", ["get", "mode"], "marker"],
      paint: {
        "circle-radius": ["case", ["get", "you"], 9, 6],
        "circle-color": "#ffffff",
        "circle-stroke-width": 3,
        "circle-stroke-color": ["get", "color"],
        "circle-opacity": 0.95,
      },
    });
    map.addLayer({
      id: "players",
      type: "circle",
      source: "players",
      filter: ["!=", ["get", "mode"], "marker"],
      paint: {
        "circle-radius": ["case", ["get", "you"], 10, 7],
        "circle-color": ["get", "color"],
        "circle-stroke-width": ["case", ["get", "you"], 3, 2],
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  /** Move the map into a screen's slot and point the camera. */
  mount(slot: HTMLElement, camera: Camera, snap: SimSnapshot | null) {
    if (this.el.parentElement !== slot) slot.prepend(this.el);
    this.camera = camera;
    this.map.resize();
    if (camera === "arena" || !snap) {
      this.map.jumpTo({ center: [this.arena.centerLon, this.arena.centerLat], zoom: 14.9 });
    } else if (camera === "yourLand") {
      this.fitYourLand(snap);
    } else {
      this.map.jumpTo({ zoom: 16.4 });
      this.follow(snap, 0);
    }
  }

  clear() {
    const empty = { type: "FeatureCollection" as const, features: [] };
    for (const id of ["owned", "players", "outside"]) {
      (this.map.getSource(id) as maplibregl.GeoJSONSource).setData(empty);
    }
  }

  update(snap: SimSnapshot, showYou: boolean) {
    (this.map.getSource("owned") as maplibregl.GeoJSONSource).setData(ownedGeoJson(snap));
    (this.map.getSource("players") as maplibregl.GeoJSONSource).setData(
      playersGeoJson(snap, showYou),
    );
    if (this.camera === "follow") this.follow(snap, 280);
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

  /** Center on a raw point (e.g. your GPS while outside the circle). */
  centerOn(p: LatLon) {
    this.map.easeTo({ center: [p.lon, p.lat], duration: 280, essential: true });
  }

  private follow(snap: SimSnapshot, duration: number) {
    const you = snap.you;
    if (!you) return;
    const p = snap.youNeedSpawn && you.respawnAt ? you.respawnAt : you;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    this.map.easeTo({ center: [p.lon, p.lat], duration, essential: true });
  }

  private fitYourLand(snap: SimSnapshot) {
    const pts = snap.you?.owned.flat() ?? [];
    if (pts.length < 3) {
      this.map.jumpTo({ center: [this.arena.centerLon, this.arena.centerLat], zoom: 15.2 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const p of pts) bounds.extend([p.lon, p.lat]);
    this.map.fitBounds(bounds, { padding: 36, maxZoom: 17.5, duration: 0 });
  }
}
