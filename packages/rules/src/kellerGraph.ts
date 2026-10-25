import { fromLocalM } from "./geo.js";
import { KELLER } from "./arena.js";
import type { GraphEdge, GraphFace, GraphNode, LobbyGraph } from "./types.js";

export { KELLER } from "./arena.js";

/**
 * Optional fixture grid (deferred path-graph mode / legacy tests).
 * Freeplay MVP does not require this for claims.
 */
export function buildKellerFixtureGraph(
  gridStepM = 80,
  pathWidthM = KELLER.pathWidthM,
): LobbyGraph {
  const { lat: originLat, lon: originLon, radiusM } = KELLER;
  const half = Math.floor(radiusM / gridStepM);
  const nodes: GraphNode[] = [];
  const index = new Map<string, number>();

  function key(ix: number, iy: number) {
    return `${ix},${iy}`;
  }

  for (let iy = -half; iy <= half; iy++) {
    for (let ix = -half; ix <= half; ix++) {
      const x = ix * gridStepM;
      const y = iy * gridStepM;
      if (Math.hypot(x, y) > radiusM - 5) continue;
      const { lat, lon } = fromLocalM(originLat, originLon, x, y);
      const id = nodes.length;
      index.set(key(ix, iy), id);
      nodes.push({ id, lat, lon });
    }
  }

  const edges: GraphEdge[] = [];
  const edgeKey = new Set<string>();

  function addEdge(a: number, b: number) {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const k = `${lo}-${hi}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const lengthM = Math.hypot(
      (na.lon - nb.lon) *
        111320 *
        Math.cos((originLat * Math.PI) / 180),
      (na.lat - nb.lat) * 111320,
    );
    edges.push({
      id: edges.length,
      a: lo,
      b: hi,
      lengthM,
      areaM2: lengthM * pathWidthM,
    });
  }

  for (let iy = -half; iy <= half; iy++) {
    for (let ix = -half; ix <= half; ix++) {
      const here = index.get(key(ix, iy));
      if (here === undefined) continue;
      const right = index.get(key(ix + 1, iy));
      const up = index.get(key(ix, iy + 1));
      if (right !== undefined) addEdge(here, right);
      if (up !== undefined) addEdge(here, up);
    }
  }

  const faces: GraphFace[] = [];
  for (let iy = -half; iy < half; iy++) {
    for (let ix = -half; ix < half; ix++) {
      const n00 = index.get(key(ix, iy));
      const n10 = index.get(key(ix + 1, iy));
      const n01 = index.get(key(ix, iy + 1));
      const n11 = index.get(key(ix + 1, iy + 1));
      if (
        n00 === undefined ||
        n10 === undefined ||
        n01 === undefined ||
        n11 === undefined
      ) {
        continue;
      }
      const eBottom = edges.find(
        (e) =>
          (e.a === n00 && e.b === n10) || (e.a === n10 && e.b === n00),
      );
      const eRight = edges.find(
        (e) =>
          (e.a === n10 && e.b === n11) || (e.a === n11 && e.b === n10),
      );
      const eTop = edges.find(
        (e) =>
          (e.a === n01 && e.b === n11) || (e.a === n11 && e.b === n01),
      );
      const eLeft = edges.find(
        (e) =>
          (e.a === n00 && e.b === n01) || (e.a === n01 && e.b === n00),
      );
      if (!eBottom || !eRight || !eTop || !eLeft) continue;
      faces.push({
        id: faces.length,
        edgeIds: [eBottom.id, eRight.id, eTop.id, eLeft.id],
        areaM2: gridStepM * gridStepM,
      });
    }
  }

  const nodeEdges = new Map<number, number[]>();
  for (const e of edges) {
    if (!nodeEdges.has(e.a)) nodeEdges.set(e.a, []);
    if (!nodeEdges.has(e.b)) nodeEdges.set(e.b, []);
    nodeEdges.get(e.a)!.push(e.id);
    nodeEdges.get(e.b)!.push(e.id);
  }

  return {
    id: "keller-fixture-v1",
    centerLat: originLat,
    centerLon: originLon,
    radiusM,
    pathWidthM,
    nodes,
    edges,
    faces,
    nodeEdges,
  };
}
