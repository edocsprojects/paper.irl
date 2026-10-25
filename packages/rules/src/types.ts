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

/**
 * Paper.io territory as a GeoJSON-style MultiPolygon in lat/lon:
 * polygons → [outer ring, ...hole rings], every ring closed (first == last).
 */
export type Territory = LatLon[][][];

/** Why a seat died: trail touched by someone, or all land taken. */
export type DeathReason = "cut" | "captured";

export interface Seat {
  id: SeatId;
  nickname: string;
  mode: SeatMode;
  color: string;
  owned: Territory;
  /** Open freehand trail while outside owned land. */
  trail: LatLon[];
  position: LatLon | null;
  respawnAt: LatLon | null;
  areaM2: number;
  ghostUntilMs: number | null;
  /** Simulated player (server-driven), not a phone. */
  bot: boolean;
  /** Last death (kill feed / respawn ring placement). */
  lastDeath: { byId: SeatId; reason: DeathReason; atMs: number; at: LatLon | null } | null;
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
  /** Min meters between successive trail samples (raised for noisy GPS). */
  trailSampleM: number;
  /** Death → respawn-eligible delay. */
  ghostMs: number;
  /** Soft-reject / push-back when outside arena. */
  boundaryMode: "clamp";
  /** Seats that tapped Play again after ended (same lobby code). */
  rematchReady: Set<SeatId>;
  /** Recent eliminations, newest last (kill feed + death markers). */
  feed: FeedEntry[];
  /** Land-taken notices, newest last (bot-loop steals must still reach phones). */
  notices: NoticeEntry[];
  /** Recent (re)spawns, newest last — drives the "pop" animation. */
  pops: PopEntry[];
  /** Demo pace multiplier for simulated walkers (bots / autopilot). 1 = real jog. */
  speedScale: number;
}

export interface NoticeEntry {
  atMs: number;
  kind: "landLost";
  seatId: SeatId;
  byId: SeatId;
  lostM2: number;
}

export interface PopEntry {
  atMs: number;
  seatId: SeatId;
  at: LatLon;
}

export interface FeedEntry {
  atMs: number;
  victimId: SeatId;
  byId: SeatId;
  reason: DeathReason;
  /** Where the victim was when they died. */
  at: LatLon | null;
}

export type Effect =
  | { kind: "planted"; seatId: SeatId; ring: LatLon[] }
  | { kind: "trailOpen"; seatId: SeatId }
  | { kind: "trailExtend"; seatId: SeatId; point: LatLon }
  | { kind: "banked"; seatId: SeatId; gainedM2: number; areaM2: number }
  | { kind: "cut"; victimId: SeatId; byId: SeatId; reason: DeathReason }
  | { kind: "landLost"; seatId: SeatId; byId: SeatId; lostM2: number }
  | { kind: "respawnAssigned"; seatId: SeatId; at: LatLon }
  | { kind: "respawnMoved"; seatId: SeatId; at: LatLon }
  | { kind: "boundaryPush"; seatId: SeatId; at: LatLon }
  | { kind: "phase"; phase: LobbyPhase }
  | { kind: "rematchReady"; seatId: SeatId; readyIds: SeatId[] }
  | { kind: "rejected"; seatId: SeatId; reason: string };
