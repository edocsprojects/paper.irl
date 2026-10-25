import {
  joinLobby,
  mulberry32,
  seatIsBot,
  tickLobby,
  wanderSeat,
  type LobbyState,
} from "@paper-irl/rules";

const botLoops = new Map<string, ReturnType<typeof setInterval>>();
const randByLobby = new Map<string, () => number>();

function randFor(code: string): () => number {
  let r = randByLobby.get(code);
  if (!r) {
    r = mulberry32(code.split("").reduce((a, c) => a + c.charCodeAt(0), 1));
    randByLobby.set(code, r);
  }
  return r;
}

/** Fill seats with BotN up to maxSeats - leaveHumanSlots bots. */
export function fillBots(lobby: LobbyState, leaveHumanSlots = 1): number {
  let added = 0;
  let n = 1;
  const botCap = lobby.maxSeats - leaveHumanSlots;
  while (lobby.seats.size < lobby.maxSeats) {
    const humanCount = [...lobby.seats.values()].filter((s) => !seatIsBot(s)).length;
    const botCount = lobby.seats.size - humanCount;
    if (botCount >= botCap) break;
    while ([...lobby.seats.values()].some((s) => s.nickname === `Bot${n}`)) n++;
    joinLobby(lobby, `Bot${n}`);
    added++;
    n++;
  }
  return added;
}

export function tickBots(lobby: LobbyState, now = Date.now()) {
  tickLobby(lobby, now);
  if (lobby.phase !== "live") return;
  const rand = randFor(lobby.code);
  for (const seat of lobby.seats.values()) {
    if (!seatIsBot(seat)) continue;
    wanderSeat(lobby, seat.id, rand, now);
  }
}

export function startBotLoop(lobby: LobbyState, ms = 1000) {
  stopBotLoop(lobby.code);
  const id = setInterval(() => {
    if (!lobby || lobby.phase === "ended") {
      stopBotLoop(lobby.code);
      return;
    }
    tickBots(lobby);
  }, ms);
  botLoops.set(lobby.code, id);
}

export function stopBotLoop(code: string) {
  const id = botLoops.get(code);
  if (id) clearInterval(id);
  botLoops.delete(code);
}
