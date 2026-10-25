/** Community events (mirrors apps/server EVENTS; ids are /events/:id). */
export interface CommunityEvent {
  id: string;
  name: string;
  place: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  durationMs: number;
}

const HOUR = 60 * 60 * 1000;

export const COMMUNITY_EVENTS: CommunityEvent[] = [
  { id: "keller", name: "Keller Hall · UMN", place: "200 Union St SE, Minneapolis", centerLat: 44.97452, centerLon: -93.23256, radiusM: 500, durationMs: HOUR },
  { id: "north-loop", name: "North Loop", place: "300 Washington Ave N, Minneapolis", centerLat: 44.98495, centerLon: -93.27252, radiusM: 500, durationMs: HOUR },
  { id: "chicago", name: "Millennium Park · Chicago", place: "201 E Randolph St, Chicago", centerLat: 41.88255, centerLon: -87.62255, radiusM: 500, durationMs: HOUR },
];
