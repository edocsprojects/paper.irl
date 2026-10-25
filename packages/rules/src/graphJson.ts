import type { LobbyGraph, NodeId, EdgeId } from "./types.js";

/** JSON-serializable graph (Maps become string-keyed records). */
export interface LobbyGraphJson {
  id: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  pathWidthM: number;
  nodes: LobbyGraph["nodes"];
  edges: LobbyGraph["edges"];
  faces: LobbyGraph["faces"];
  nodeEdges: Record<string, number[]>;
  source?: string;
  attribution?: string;
}

export function graphToJson(graph: LobbyGraph): LobbyGraphJson {
  const nodeEdges: Record<string, number[]> = {};
  for (const [k, v] of graph.nodeEdges) {
    nodeEdges[String(k)] = v;
  }
  return {
    id: graph.id,
    centerLat: graph.centerLat,
    centerLon: graph.centerLon,
    radiusM: graph.radiusM,
    pathWidthM: graph.pathWidthM,
    nodes: graph.nodes,
    edges: graph.edges,
    faces: graph.faces,
    nodeEdges,
  };
}

export function graphFromJson(raw: LobbyGraphJson): LobbyGraph {
  const nodeEdges = new Map<NodeId, EdgeId[]>();
  for (const [k, v] of Object.entries(raw.nodeEdges)) {
    nodeEdges.set(Number(k), v);
  }
  return {
    id: raw.id,
    centerLat: raw.centerLat,
    centerLon: raw.centerLon,
    radiusM: raw.radiusM,
    pathWidthM: raw.pathWidthM,
    nodes: raw.nodes,
    edges: raw.edges,
    faces: raw.faces ?? [],
    nodeEdges,
  };
}
