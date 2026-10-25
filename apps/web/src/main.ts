import maplibregl from "maplibre-gl";
import {
  graphFromJson,
  type LobbyGraph,
  type LobbyGraphJson,
} from "@paper-irl/rules";
import { CampusSim, type SimSnapshot } from "./botSim.js";
import "./styles.css";

const ESRI_SAT =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

function formatMs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function edgeLine(
  graph: LobbyGraph,
  edgeId: number,
): [number, number][] {
  const e = graph.edges[edgeId]!;
  const a = graph.nodes[e.a]!;
  const b = graph.nodes[e.b]!;
  return [
    [a.lon, a.lat],
    [b.lon, b.lat],
  ];
}

function ownedGeoJson(graph: LobbyGraph, snap: SimSnapshot) {
  const features: GeoJSON.Feature[] = [];
  for (const seat of snap.seats) {
    for (const edgeId of seat.ownedEdges) {
      features.push({
        type: "Feature",
        properties: { color: seat.color, kind: "owned" },
        geometry: { type: "LineString", coordinates: edgeLine(graph, edgeId) },
      });
    }
    for (const edgeId of seat.trail) {
      features.push({
        type: "Feature",
        properties: { color: seat.color, kind: "trail" },
        geometry: { type: "LineString", coordinates: edgeLine(graph, edgeId) },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function playersGeoJson(graph: LobbyGraph, snap: SimSnapshot) {
  const features: GeoJSON.Feature[] = [];
  for (const seat of snap.seats) {
    features.push({
      type: "Feature",
      properties: {
        color: seat.color,
        nickname: seat.nickname,
        mode: seat.mode,
      },
      geometry: {
        type: "Point",
        coordinates: [seat.lon, seat.lat],
      },
    });
    if (seat.respawnNode != null) {
      const n = graph.nodes[seat.respawnNode]!;
      features.push({
        type: "Feature",
        properties: {
          color: seat.color,
          nickname: seat.nickname,
          mode: "marker",
        },
        geometry: {
          type: "Point",
          coordinates: [n.lon, n.lat],
        },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function pathsGeoJson(graph: LobbyGraph) {
  return {
    type: "FeatureCollection" as const,
    features: graph.edges.map((e) => {
      const a = graph.nodes[e.a]!;
      const b = graph.nodes[e.b]!;
      return {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [a.lon, a.lat],
            [b.lon, b.lat],
          ],
        },
      };
    }),
  };
}

function renderScores(snap: SimSnapshot) {
  const el = document.getElementById("scores")!;
  const ranked = [...snap.seats].sort((a, b) => b.areaM2 - a.areaM2);
  el.innerHTML = ranked
    .map(
      (s) => `<li>
      <span class="swatch" style="background:${s.color}"></span>
      <span>${s.nickname} <span class="mode">${s.mode}</span></span>
      <span>${Math.round(s.areaM2)} m²</span>
    </li>`,
    )
    .join("");
}

async function main() {
  const res = await fetch("/keller-graph.json");
  if (!res.ok) throw new Error("failed to load keller-graph.json");
  const raw = (await res.json()) as LobbyGraphJson;
  const graph = graphFromJson(raw);

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        sat: {
          type: "raster",
          tiles: [ESRI_SAT],
          tileSize: 256,
          attribution: "Esri, Maxar, Earthstar Geographics",
        },
      },
      layers: [
        {
          id: "sat",
          type: "raster",
          source: "sat",
          minzoom: 0,
          maxzoom: 22,
        },
      ],
    },
    center: [graph.centerLon, graph.centerLat],
    zoom: 15.2,
    pitch: 0,
    maxBounds: [
      [graph.centerLon - 0.02, graph.centerLat - 0.015],
      [graph.centerLon + 0.02, graph.centerLat + 0.015],
    ],
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

  await map.once("load");

  map.addSource("paths", { type: "geojson", data: pathsGeoJson(graph) });
  map.addLayer({
    id: "paths",
    type: "line",
    source: "paths",
    paint: {
      "line-color": "#f4efe6",
      "line-opacity": 0.35,
      "line-width": 2.2,
    },
  });

  map.addSource("owned", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "owned",
    type: "line",
    source: "owned",
    filter: ["==", ["get", "kind"], "owned"],
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 0.85,
      "line-width": 5,
    },
  });
  map.addLayer({
    id: "trails",
    type: "line",
    source: "owned",
    filter: ["==", ["get", "kind"], "trail"],
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 0.95,
      "line-width": 3.2,
      "line-dasharray": [1.2, 1.2],
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
      "circle-radius": 7,
      "circle-color": "#ffffff",
      "circle-stroke-width": 3,
      "circle-stroke-color": ["get", "color"],
      "circle-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "players",
    type: "circle",
    source: "players",
    filter: ["!=", ["get", "mode"], "marker"],
    paint: {
      "circle-radius": 8,
      "circle-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#0b0f0d",
    },
  });

  let sim = new CampusSim(graph);
  let playing = true;
  let speed = 30;
  let acc = 0;
  let last = performance.now();

  const phaseEl = document.getElementById("phase")!;
  const timerEl = document.getElementById("timer")!;
  const playBtn = document.getElementById("btn-play") as HTMLButtonElement;
  const restartBtn = document.getElementById("btn-restart") as HTMLButtonElement;
  const speedSel = document.getElementById("speed") as HTMLSelectElement;

  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "Pause" : "Play";
    last = performance.now();
  });
  restartBtn.addEventListener("click", () => {
    sim.restart();
    playing = true;
    playBtn.textContent = "Pause";
    acc = 0;
    last = performance.now();
    paint();
  });
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value) || 30;
  });

  function paint() {
    const snap = sim.snapshot();
    phaseEl.textContent = snap.phase;
    timerEl.textContent = formatMs(snap.remainingMs);
    renderScores(snap);
    (map.getSource("owned") as maplibregl.GeoJSONSource).setData(
      ownedGeoJson(graph, snap),
    );
    (map.getSource("players") as maplibregl.GeoJSONSource).setData(
      playersGeoJson(graph, snap),
    );
  }

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && sim.state.phase !== "ended") {
      acc += dt * speed;
      let guard = 0;
      while (acc >= 1 && guard < 40) {
        sim.tickOnce();
        acc -= 1;
        guard++;
      }
      paint();
    } else if (sim.state.phase === "ended") {
      paint();
      playBtn.textContent = "Ended";
    }
    requestAnimationFrame(frame);
  }

  paint();
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#f66;padding:2rem">Demo failed: ${String(err)}</pre>`;
});
