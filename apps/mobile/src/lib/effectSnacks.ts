import type { GameEffect, LobbyPayload, SeatView } from "./api";
import type { SnackTone } from "../state/appMachine";
import { sqft } from "./units";

export type SnackEvent = { text: string; tone: SnackTone };

function nick(seats: SeatView[], id: number): string {
  return seats.find((s) => s.id === id)?.nickname ?? `P${id}`;
}

/**
 * Map server effects → SnackbarHost toasts for the local seat.
 * Death wipe copy is owned by the appMachine LOBBY transition (short toast).
 */
export function snacksFromEffects(
  effects: GameEffect[] | undefined,
  youId: number,
  lobby: LobbyPayload,
): SnackEvent[] {
  if (!effects?.length) return [];
  const seats = lobby.seats;
  let cut: SnackEvent | null = null;
  let banked: SnackEvent | null = null;
  let boundary: SnackEvent | null = null;
  for (const e of effects) {
    if (e.kind === "banked" && e.seatId === youId) {
      const gained = Number((e as { gainedM2?: number }).gainedM2 ?? 0);
      banked = { text: gained >= 1 ? `+${sqft(gained)} claimed` : "You banked land", tone: "good" };
    }
    if (e.kind === "cut" && e.byId === youId && e.victimId !== youId) {
      const who = nick(seats, e.victimId as number);
      cut = {
        text: e.reason === "captured" ? `You took all of ${who}'s land` : `You cut ${who}`,
        tone: "good",
      };
    }

    if (e.kind === "boundaryPush" && e.seatId === youId) {
      boundary = { text: "Outside the boundary", tone: "warn" };
    }
  }
  // One toast per tick (SnackbarHost is single-slot); prefer the punchiest.
  if (cut) return [cut];
  if (banked) return [banked];
  if (boundary) return [boundary];
  return [];
}
