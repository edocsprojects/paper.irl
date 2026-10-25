import type { SeatView } from "./api";

/** "Player 4", or "Player 1 (You)" for the local seat. */
export function seatLabel(seats: SeatView[], id: number, youId: number): string {
  const nick = seats.find((s) => s.id === id)?.nickname ?? `Player ${id}`;
  return id === youId ? `${nick} (You)` : nick;
}
