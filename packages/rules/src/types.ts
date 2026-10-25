export type SeatId = number;

/** Deferred / optional OSM path graph ids (basemap / later modes). */
export type NodeId = number;
export type EdgeId = number;
export type FaceId = number;

export type LobbyPhase = "open" | "live" | "ended";
export type SeatMode =
  | "joining"
  | "toPlant"
  | "safe"
  | "trailing"
  | "ghost"
  | "left";

export interface LatLon {
  lat: number;
  lon: number;
}

/** Circular (or later polygonal) play boundary. Freeplay MVP uses a circle. */
export interface Arena {
  id: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  /** Corridor width used when scoring thin trail claims. */
  pathWidthM: number;
  starterRadiusM: number;
}

/** Optional OSM centerline graph — not required for freeplay MVP. */
export interface GraphNode {
  id: NodeId;
  lat: number;
  lon: number;
}

export interface GraphEdge {
  id: EdgeId;
  a: NodeId;
  b: NodeId;
  lengthM: number;
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
  nodeEdges: Map<NodeId, EdgeId[]>;
}

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps: number;
  clientTsMs: number;
  mock?: boolean;
  /**
   * Plant / respawn control while in toPlant:
   * - true: plant when within plantRadius (tap-to-spawn)
   * - false: move only — never auto-plant (Manual drag)
   * - undefined: plant when within plantRadius (bots / Auto sim)
   */
  plant?: boolean;
}

export interface Seat {
  id: SeatId;
  nickname: string;
  mode: SeatMode;
  color: string;
  /** Closed rings (lat/lon), paper.io-style territory. */
  owned: LatLon[][];
  /** Open freehand trail while outside owned land. */
  trail: LatLon[];
  position: LatLon | null;
  respawnAt: LatLon | null;
  areaM2: number;
  ghostUntilMs: number | null;
}

export interface LobbyState {
  code: string;
  phase: LobbyPhase;
  durationMs: number;
  startedAtMs: number | null;
  endsAtMs: number | null;
  arena: Arena;
  seats: Map<SeatId, Seat>;
  nextSeatId: SeatId;
  cutProximityM: number;
  plantDwellMs: number;
  plantRadiusM: number;
  pathWidthM: number;
  maxSeats: number;
  /** Min meters between successive trail samples. */
  trailSampleM: number;
  /** Soft-reject / push-back when outside arena. */
  boundaryMode: "clamp";
  /** Seats that tapped Play again after ended (same lobby code). */
  rematchReady: Set<SeatId>;
}

export type Effect =
  | { kind: "planted"; seatId: SeatId; ring: LatLon[] }
  | { kind: "trailOpen"; seatId: SeatId }
  | { kind: "trailExtend"; seatId: SeatId; point: LatLon }
  | { kind: "banked"; seatId: SeatId; ring: LatLon[]; areaM2: number }
  | { kind: "cut"; victimId: SeatId; byId: SeatId }
  | { kind: "respawnAssigned"; seatId: SeatId; at: LatLon }
  | { kind: "respawnMoved"; seatId: SeatId; at: LatLon }
  | { kind: "boundaryPush"; seatId: SeatId; at: LatLon }
  | { kind: "phase"; phase: LobbyPhase }
  | { kind: "rematchReady"; seatId: SeatId; readyIds: SeatId[] }
  | { kind: "rejected"; seatId: SeatId; reason: string };
