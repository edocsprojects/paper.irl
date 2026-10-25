import { useEffect, useRef } from "react";
import { pointInTerritory } from "@paper-irl/rules";
import type { LobbyPayload } from "./api";
import type { SnackTone } from "../state/appMachine";
import { sqft } from "./units";

type Snack = (text: string, tone: SnackTone) => void;

const RAID_COOLDOWN_MS = 10_000;

function nick(lobby: LobbyPayload, id: number): string {
  return lobby.seats.find((s) => s.id === id)?.nickname ?? `Player ${id}`;
}

const m2 = sqft;

/**
 * Turns lobby state into toasts the player should never miss, including
 * events caused by other players (which never come back as our own effects):
 * land taken from you, land you took, a raider inside your land, the lead
 * changing hands, one minute left, and being back in after a respawn.
 */
export function useGameNotices(
  lobby: LobbyPayload | null,
  youId: number,
  remainingMs: number,
  snack: Snack,
) {
  const seenNotice = useRef<number | null>(null);
  const seenPop = useRef<number | null>(null);
  const raidAt = useRef(new Map<number, number>());
  const inside = useRef(new Set<number>());
  const leader = useRef<number | null>(null);
  const warnedMinute = useRef(false);

  useEffect(() => {
    if (!lobby || lobby.phase !== "live") return;
    const now = lobby.serverNowMs ?? Date.now();
    const out: { text: string; tone: SnackTone; rank: number }[] = [];

    // Land taken (from the server's notice log — bot-loop steals included).
    const notices = lobby.notices ?? [];
    const newestNotice = notices.length ? notices[notices.length - 1]!.atMs : 0;
    if (seenNotice.current === null) seenNotice.current = newestNotice;
    for (const n of notices) {
      if (n.atMs <= seenNotice.current) continue;
      if (n.seatId === youId) {
        out.push({ text: `${nick(lobby, n.byId)} took ${m2(n.lostM2)} of your land`, tone: "warn", rank: 3 });
      } else if (n.byId === youId) {
        out.push({ text: `You took ${m2(n.lostM2)} from ${nick(lobby, n.seatId)}`, tone: "good", rank: 2 });
      }
    }
    seenNotice.current = Math.max(seenNotice.current, newestNotice);

    // Back in after a respawn.
    const pops = lobby.pops ?? [];
    const newestPop = pops.length ? pops[pops.length - 1]!.atMs : 0;
    if (seenPop.current === null) seenPop.current = newestPop;
    for (const p of pops) {
      if (p.atMs > seenPop.current && p.seatId === youId) {
        out.push({ text: "You're back in!", tone: "good", rank: 1 });
      }
    }
    seenPop.current = Math.max(seenPop.current, newestPop);

    // Raider alert: someone's open trail head is inside your land.
    const you = lobby.seats.find((s) => s.id === youId);
    const nowInside = new Set<number>();
    if (you && you.owned.length) {
      for (const s of lobby.seats) {
        if (s.id === youId || s.mode !== "trailing" || !s.position) continue;
        if (!pointInTerritory(s.position, you.owned)) continue;
        nowInside.add(s.id);
        const last = raidAt.current.get(s.id) ?? 0;
        if (!inside.current.has(s.id) && now - last > RAID_COOLDOWN_MS) {
          raidAt.current.set(s.id, now);
          out.push({ text: `${s.nickname} is raiding your land — cut their trail!`, tone: "warn", rank: 4 });
        }
      }
    }
    inside.current = nowInside;

    // Lead changes.
    const top = lobby.top3[0];
    if (top && top.areaM2 > 0) {
      const prev = leader.current;
      if (prev !== null && prev !== top.id) {
        if (top.id === youId) out.push({ text: "You took the lead!", tone: "good", rank: 2 });
        else if (prev === youId) out.push({ text: `${top.nickname} passed you for #1`, tone: "warn", rank: 2 });
      }
      leader.current = top.id;
    }

    // One minute left.
    if (!warnedMinute.current && remainingMs > 0 && remainingMs <= 60_000) {
      warnedMinute.current = true;
      out.push({ text: "1 minute left!", tone: "neutral", rank: 5 });
    }

    if (out.length) {
      const best = out.sort((a, b) => b.rank - a.rank)[0]!;
      snack(best.text, best.tone);
    }
    // remainingMs is read on each lobby update; no need to re-run every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby, youId]);
}
