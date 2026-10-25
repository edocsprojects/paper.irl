export type NodeId = number;
export type EdgeId = number;
export type FaceId = number;
export type SeatId = number;

export type LobbyPhase = "open" | "live" | "ended";
export type SeatMode =
  | "joining"
  | "toPlant"
  | "safe"
  | "trailing"
  | "ghost"
  | "left";

export interface GraphNode {
  id: NodeId;
  lat: number;
  lon: number;
}

/** Undirected centerline interval between two nodes. */
export interface GraphEdge {
  id: EdgeId;
  a: NodeId;
  b: NodeId;
  lengthM: number;
  /** Corridor area contribution (length × pathWidthM). */
  areaM2: number;
}

export interface GraphFace {
  id: FaceId;
  edgeIds: EdgeId[];
  areaM2: number;
}

export interface LobbyGraph {
  id: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  pathWidthM: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  faces: GraphFace[];
  /** adjacency: nodeId -> edgeIds */
  nodeEdges: Map<NodeId, EdgeId[]>;
}

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps: number;
  clientTsMs: number;
  mock?: boolean;
}

export interface Seat {
  id: SeatId;
  nickname: string;
  mode: SeatMode;
  color: string;
  /** Owned undirected edges. */
  ownedEdges: Set<EdgeId>;
  ownedFaces: Set<FaceId>;
  trail: EdgeId[];
  headEdge: EdgeId | null;
  headNode: NodeId | null;
  respawnNode: NodeId | null;
  areaM2: number;
  ghostUntilMs: number | null;
}

export interface LobbyState {
  code: string;
  phase: LobbyPhase;
  durationMs: number;
  startedAtMs: number | null;
  endsAtMs: number | null;
  graph: LobbyGraph;
  /** edgeId -> seatId owner, or null if tracked separately via seats */
  edgeOwner: Map<EdgeId, SeatId>;
  faceOwner: Map<FaceId, SeatId>;
  seats: Map<SeatId, Seat>;
  nextSeatId: SeatId;
  cutOverlapM: number;
  plantDwellMs: number;
  plantRadiusM: number;
  pathWidthM: number;
  maxSeats: number;
}

export type Effect =
  | { kind: "planted"; seatId: SeatId; edges: EdgeId[] }
  | { kind: "trailOpen"; seatId: SeatId }
  | { kind: "trailExtend"; seatId: SeatId; edgeId: EdgeId }
  | { kind: "banked"; seatId: SeatId; edges: EdgeId[]; faces: FaceId[] }
  | { kind: "cut"; victimId: SeatId; byId: SeatId }
  | { kind: "respawnAssigned"; seatId: SeatId; nodeId: NodeId }
  | { kind: "respawnMoved"; seatId: SeatId; nodeId: NodeId }
  | { kind: "phase"; phase: LobbyPhase }
  | { kind: "rejected"; seatId: SeatId; reason: string };
