import maplibregl from "maplibre-gl";
import {
  graphFromJson,
  type Effect,
  type LobbyGraph,
  type LobbyGraphJson,
} from "@paper-irl/rules";
import { CampusSim, YOU_ID, type SimSnapshot } from "./botSim.js";
import "./styles.css";

/** Free street style (no API key / watermark). */
const STREET_STYLE = "https://tiles.openfreemap.org/styles/bright";

function formatMs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function darken(hex: string, amount = 0.28): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amount));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amount));
  const b = Math.max(0, (n & 255) * (1 - amount));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function edgeLine(graph: LobbyGraph, edgeId: number): [number, number][] {
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
    const border = darken(seat.color, 0.32);
    for (const edgeId of seat.ownedEdges) {
      features.push({
        type: "Feature",
        properties: {
          fill: seat.color,
          border,
          kind: "owned",
        },
        geometry: { type: "LineString", coordinates: edgeLine(graph, edgeId) },
      });
    }
    for (const edgeId of seat.trail) {
      features.push({
        type: "Feature",
        properties: {
          fill: seat.color,
          border,
          kind: "trail",
        },
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
        you: seat.id === YOU_ID,
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
          you: seat.id === YOU_ID,
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

function nameOf(snap: SimSnapshot, id: number): string {
  return snap.seats.find((s) => s.id === id)?.nickname ?? `P${id}`;
}

class SnackBus {
  private root = document.getElementById("snacks")!;
  private seenTime = new Set<number>();
  private lastRank = -1;
  private wasTrailing = false;
  private lastArea = 0;

  push(text: string, tone: "neutral" | "good" | "warn" | "bad" = "neutral") {
    const el = document.createElement("div");
    el.className = `snack ${tone === "neutral" ? "" : tone}`.trim();
    el.textContent = text;
    this.root.prepend(el);
    while (this.root.children.length > 3) {
      this.root.lastElementChild?.remove();
    }
    window.setTimeout(() => el.remove(), 4200);
  }

  onEffects(effects: Effect[], snap: SimSnapshot) {
    for (const e of effects) {
      if (e.kind === "cut") {
        if (e.victimId === YOU_ID) {
          this.push(`${nameOf(snap, e.byId)} eliminated you`, "bad");
        } else if (e.byId === YOU_ID) {
          this.push(`You eliminated ${nameOf(snap, e.victimId)}`, "good");
        }
      }
      if (e.kind === "planted" && e.seatId === YOU_ID) {
        this.push("You're planted — go claim paths", "good");
      }
      if (e.kind === "banked" && e.seatId === YOU_ID) {
        this.push("Land banked", "good");
      }
      if (e.kind === "respawnMoved" && e.seatId === YOU_ID) {
        this.push("Your respawn marker moved", "warn");
      }
      if (e.kind === "phase" && e.phase === "ended") {
        this.push("Match over", "warn");
      }
    }
  }

  onSnapshot(snap: SimSnapshot) {
    const mins = [10, 5, 1];
    for (const m of mins) {
      const threshold = m * 60 * 1000;
      if (
        snap.remainingMs <= threshold &&
        snap.remainingMs > threshold - 1500 &&
        !this.seenTime.has(m)
      ) {
        this.seenTime.add(m);
        this.push(`${m} minute${m === 1 ? "" : "s"} remaining`, "warn");
      }
    }

    const rank = snap.top3.findIndex((s) => s.id === YOU_ID);
    if (rank === 0 && this.lastRank !== 0 && snap.you && snap.you.areaM2 > 0) {
      this.push("You're in 1st place", "good");
    }
    this.lastRank = rank;

    const you = snap.you;
    if (you) {
      if (you.mode === "trailing" && !this.wasTrailing) {
        this.push("Trail open — get home to bank", "neutral");
      }
      if (you.areaM2 > this.lastArea + 400 && you.mode === "safe") {
        // big claim already covered by banked; skip duplicate
      }
      this.wasTrailing = you.mode === "trailing";
      this.lastArea = you.areaM2;
    }
  }

  reset() {
    this.seenTime.clear();
    this.lastRank = -1;
    this.wasTrailing = false;
    this.lastArea = 0;
    this.root.innerHTML = "";
  }
}

function renderLeaderboard(snap: SimSnapshot) {
  const el = document.getElementById("leaderboard")!;
  const rows = snap.top3
    .map(
      (s, i) => `<li>
      <span class="rank">${i + 1}</span>
      <span class="swatch" style="background:${s.color}"></span>
      <span>${s.nickname}</span>
      <span class="area">${Math.round(s.areaM2)} m²</span>
    </li>`,
    )
    .join("");
  el.innerHTML = `<p class="board-title">Leaderboard</p><ol>${rows || "<li><span class=\"rank\">–</span><span></span><span>Waiting…</span><span></span></li>"}</ol>`;
}

function renderFinal(snap: SimSnapshot) {
  const el = document.getElementById("final-top")!;
  el.innerHTML = snap.top3
    .map(
      (s, i) => `<li>
      <span>${i + 1}</span>
      <span class="swatch" style="background:${s.color};width:10px;height:10px;border-radius:999px;display:inline-block"></span>
      <span>${s.nickname}</span>
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
    style: STREET_STYLE,
    center: [graph.centerLon, graph.centerLat],
    zoom: 16.2,
    pitch: 0,
    maxBounds: [
      [graph.centerLon - 0.02, graph.centerLat - 0.015],
      [graph.centerLon + 0.02, graph.centerLat + 0.015],
    ],
  });

  await map.once("load");

  map.addSource("paths", { type: "geojson", data: pathsGeoJson(graph) });
  map.addLayer({
    id: "paths",
    type: "line",
    source: "paths",
    paint: {
      "line-color": "#6b7280",
      "line-opacity": 0.45,
      "line-width": 1.8,
    },
  });

  map.addSource("owned", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  // Soft fill (lighter / wider)
  map.addLayer({
    id: "owned-fill",
    type: "line",
    source: "owned",
    filter: ["==", ["get", "kind"], "owned"],
    paint: {
      "line-color": ["get", "fill"],
      "line-opacity": 0.38,
      "line-width": 14,
      "line-blur": 0.4,
    },
  });
  // Deep border
  map.addLayer({
    id: "owned-border",
    type: "line",
    source: "owned",
    filter: ["==", ["get", "kind"], "owned"],
    paint: {
      "line-color": ["get", "border"],
      "line-opacity": 0.95,
      "line-width": 4.5,
    },
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

  let sim = new CampusSim(graph);
  const snacks = new SnackBus();
  let playing = true;
  let speed = 30;
  let acc = 0;
  let last = performance.now();
  let hasPlantedOnce = false;

  const timerEl = document.getElementById("timer")!;
  const spawnEl = document.getElementById("spawn")!;
  const endedEl = document.getElementById("ended")!;
  const spawnKicker = document.getElementById("spawn-kicker")!;
  const spawnTitle = document.getElementById("spawn-title")!;
  const spawnCopy = document.getElementById("spawn-copy")!;
  const playBtn = document.getElementById("btn-play") as HTMLButtonElement;
  const spawnBtn = document.getElementById("btn-spawn") as HTMLButtonElement;
  const restartBtn = document.getElementById("btn-restart") as HTMLButtonElement;
  const speedSel = document.getElementById("speed") as HTMLSelectElement;

  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "Pause" : "Play";
    last = performance.now();
  });

  function doSpawn() {
    if (!sim.snapshot().youNeedSpawn) return;
    const effects = sim.spawnYou();
    if (effects.some((e) => e.kind === "planted" && e.seatId === YOU_ID)) {
      hasPlantedOnce = true;
    }
    const snap = sim.snapshot();
    snacks.onEffects(effects, snap);
    paint();
  }

  // Tap/click anywhere on the spawn overlay (not button-only).
  spawnEl.addEventListener("click", (ev) => {
    ev.preventDefault();
    doSpawn();
  });
  spawnBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    doSpawn();
  });

  restartBtn.addEventListener("click", () => {
    sim.restart();
    snacks.reset();
    hasPlantedOnce = false;
    playing = true;
    playBtn.textContent = "Pause";
    acc = 0;
    last = performance.now();
    endedEl.classList.add("hidden");
    paint();
  });

  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value) || 30;
  });

  function syncSpawnUi(snap: SimSnapshot) {
    if (snap.phase === "ended") {
      spawnEl.classList.add("hidden");
      endedEl.classList.remove("hidden");
      renderFinal(snap);
      return;
    }
    endedEl.classList.add("hidden");
    if (snap.youNeedSpawn) {
      if (hasPlantedOnce) {
        spawnKicker.textContent = "Wiped";
        spawnTitle.textContent = "Respawn";
        spawnCopy.textContent =
          "Your land went neutral. Tap anywhere to plant at your marker and get back in.";
      } else {
        spawnKicker.textContent = "Match start";
        spawnTitle.textContent = "Ready to plant";
        spawnCopy.textContent =
          "You're Player 1. Tap anywhere to drop on your marker — other runners are already moving.";
      }
      spawnEl.classList.remove("hidden");
    } else {
      spawnEl.classList.add("hidden");
    }
  }

  function followYou(snap: SimSnapshot) {
    const you = snap.you;
    if (!you) return;
    let lat = you.lat;
    let lon = you.lon;
    if (snap.youNeedSpawn && you.respawnNode != null) {
      const n = graph.nodes[you.respawnNode]!;
      lat = n.lat;
      lon = n.lon;
    }
    map.easeTo({
      center: [lon, lat],
      duration: 280,
      essential: true,
    });
  }

  function paint(effects: Effect[] = []) {
    const snap = sim.snapshot();
    if (effects.some((e) => e.kind === "cut" && e.victimId === YOU_ID)) {
      hasPlantedOnce = true;
    }
    if (effects.some((e) => e.kind === "planted" && e.seatId === YOU_ID)) {
      hasPlantedOnce = true;
    }
    timerEl.textContent = formatMs(snap.remainingMs);
    renderLeaderboard(snap);
    syncSpawnUi(snap);
    if (effects.length) snacks.onEffects(effects, snap);
    snacks.onSnapshot(snap);
    (map.getSource("owned") as maplibregl.GeoJSONSource).setData(
      ownedGeoJson(graph, snap),
    );
    (map.getSource("players") as maplibregl.GeoJSONSource).setData(
      playersGeoJson(graph, snap),
    );
    followYou(snap);
  }

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && sim.state.phase !== "ended") {
      acc += dt * speed;
      const bundled: Effect[] = [];
      let guard = 0;
      while (acc >= 1 && guard < 40) {
        bundled.push(...sim.tickOnce());
        acc -= 1;
        guard++;
      }
      paint(bundled);
    } else if (sim.state.phase === "ended") {
      paint();
    }
    requestAnimationFrame(frame);
  }

  paint();
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#c00;padding:2rem;font-family:Manrope,sans-serif">Demo failed: ${String(err)}</pre>`;
});
