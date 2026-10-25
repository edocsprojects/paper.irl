/**
 * 8-bot mock lobby — freeplay GPS inside the Keller Hall 500 m circle.
 * Synthetic random walks — plant, trail, bank, cut, wipe, respawn.
 * Exit 0 only if all invariants hold.
 */
import {
  applyFix,
  buildKellerArena,
  clampToArena,
  createLobby,
  fromLocalM,
  joinLobby,
  seatPublicView,
  startLobby,
  tickLobby,
  toLocalM,
  topScores,
  type LatLon,
  type LobbyState,
  type Seat,
} from "@paper-irl/rules";

const SEED = 42;
const BOTS = 8;
const TICKS = 900;
const DURATION_MS = 60_000;

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SIM_FAIL: ${msg}`);
}

const headings = new Map<number, number>();

function botStep(
  state: LobbyState,
  seat: Seat,
  rand: () => number,
  now: number,
) {
  const arena = state.arena;
  let pos: LatLon =
    seat.position ??
    seat.respawnAt ??
    fromLocalM(arena.centerLat, arena.centerLon, 0, 0);

  if (seat.mode === "toPlant" && seat.respawnAt !== null) {
    pos = { ...seat.respawnAt };
  } else {
    let heading = headings.get(seat.id) ?? rand() * Math.PI * 2;
    if (seat.mode === "safe" && rand() < 0.45) {
      const prey = [...state.seats.values()].find(
        (s) =>
          s.id !== seat.id &&
          s.mode === "trailing" &&
          s.trail.length >= 2,
      );
      if (prey) {
        const tip = prey.trail[prey.trail.length - 1]!;
        const local = toLocalM(pos.lat, pos.lon, tip.lat, tip.lon);
        heading = Math.atan2(local.y, local.x);
      } else {
        heading += (rand() - 0.5) * 1.2;
      }
    } else if (seat.mode === "trailing" && seat.owned[0]) {
      // Bias home to bank loops
      if (rand() < 0.35) {
        const home = seat.owned[0]![0]!;
        const local = toLocalM(pos.lat, pos.lon, home.lat, home.lon);
        heading = Math.atan2(local.y, local.x) + (rand() - 0.5) * 0.8;
      } else {
        heading += (rand() - 0.5) * 0.9;
      }
    } else {
      heading += (rand() - 0.5) * 1.1;
    }

    const stepM = 4 + rand() * 6;
    let next = fromLocalM(
      pos.lat,
      pos.lon,
      Math.cos(heading) * stepM,
      Math.sin(heading) * stepM,
    );
    next = clampToArena(arena, next);
    // Reflect if we got clamped hard
    const before = toLocalM(arena.centerLat, arena.centerLon, pos.lat, pos.lon);
    const after = toLocalM(arena.centerLat, arena.centerLon, next.lat, next.lon);
    if (Math.hypot(after.x, after.y) > arena.radiusM * 0.96) {
      heading += Math.PI * (0.6 + rand() * 0.5);
    }
    void before;
    headings.set(seat.id, heading);
    pos = next;
  }

  applyFix(
    state,
    seat.id,
    {
      lat: pos.lat + (rand() - 0.5) * 0.00001,
      lon: pos.lon + (rand() - 0.5) * 0.00001,
      accuracyM: 5 + rand() * 4,
      speedMps: 1 + rand() * 3,
      clientTsMs: now,
      mock: true,
    },
    now,
  );
}

function checkInvariants(state: LobbyState, label: string) {
  assert(state.seats.size <= 8, `${label}: more than 8 seats`);
  for (const seat of state.seats.values()) {
    if (seat.mode === "toPlant" || seat.mode === "ghost") {
      assert(
        seat.owned.length === 0,
        `${label}: ${seat.nickname} ghost/toPlant still owns land`,
      );
      assert(
        seat.trail.length === 0,
        `${label}: ${seat.nickname} should not trail while ${seat.mode}`,
      );
    }
    if (seat.mode === "toPlant") {
      assert(
        seat.respawnAt !== null,
        `${label}: ${seat.nickname} toPlant without marker`,
      );
    }
    if (seat.position) {
      const local = toLocalM(
        state.arena.centerLat,
        state.arena.centerLon,
        seat.position.lat,
        seat.position.lon,
      );
      assert(
        Math.hypot(local.x, local.y) <= state.arena.radiusM + 2,
        `${label}: ${seat.nickname} outside arena`,
      );
    }
  }
}

function main() {
  const rand = mulberry32(SEED);
  const arena = buildKellerArena();
  const lobby = createLobby("SIM8", arena, {
    durationMs: DURATION_MS,
    maxSeats: BOTS,
  });

  for (let i = 0; i < BOTS; i++) {
    joinLobby(lobby, `Bot${i + 1}`);
  }
  assert(lobby.seats.size === 8, "expected 8 bots");

  const t0 = Date.UTC(2026, 9, 24, 18, 0, 0);
  startLobby(lobby, t0);
  checkInvariants(lobby, "after-start");

  let cuts = 0;
  let plants = 0;
  let banks = 0;

  for (let tick = 0; tick < TICKS; tick++) {
    const simNow = t0 + Math.floor((tick / TICKS) * (DURATION_MS + 2000));
    for (const seat of lobby.seats.values()) {
      const beforeMode = seat.mode;
      const beforeTrail = seat.trail.length;
      const beforeOwned = seat.owned.length;
      botStep(lobby, seat, rand, simNow);
      if (beforeMode === "toPlant" && seat.mode === "safe") plants++;
      if (seat.mode === "safe" && beforeTrail > 0 && seat.trail.length === 0) {
        banks++;
      }
      if (
        beforeOwned > 0 &&
        seat.owned.length === 0 &&
        seat.mode === "toPlant"
      ) {
        cuts++;
      }
    }

    // Guaranteed hunt: teleport a safe bot onto a trailing bot's trail tip
    if (tick % 5 === 0) {
      const prey = [...lobby.seats.values()].find(
        (s) => s.mode === "trailing" && s.trail.length >= 2,
      );
      const hunter = [...lobby.seats.values()].find(
        (s) => s.mode === "safe" && prey && s.id !== prey.id,
      );
      if (prey && hunter) {
        const tip = prey.trail[Math.floor(prey.trail.length / 2)]!;
        const beforeOwned = prey.owned.length;
        applyFix(
          lobby,
          hunter.id,
          {
            lat: tip.lat,
            lon: tip.lon,
            accuracyM: 5,
            speedMps: 2,
            clientTsMs: simNow,
            mock: true,
          },
          simNow,
        );
        if (
          beforeOwned > 0 &&
          prey.owned.length === 0 &&
          prey.mode === "toPlant"
        ) {
          cuts++;
        }
      }
    }

    tickLobby(lobby, simNow);
    if (tick % 50 === 0) checkInvariants(lobby, `tick-${tick}`);
    if (lobby.phase === "ended") break;
  }

  tickLobby(lobby, t0 + DURATION_MS + 1000);
  assert(lobby.phase === "ended", "lobby should have ended");
  checkInvariants(lobby, "ended");

  const top = topScores(lobby, 3);
  assert(top.length === 3, "top 3 required");
  assert(top[0]!.areaM2 >= top[1]!.areaM2, "top sorted");
  assert(plants >= 8, "every bot should plant at least once");
  assert(cuts >= 1, "expected at least one wipe from trail cuts");
  assert(banks >= 1, "expected at least one bank");

  let lateJoinBlocked = false;
  try {
    joinLobby(lobby, "Late");
  } catch {
    lateJoinBlocked = true;
  }
  assert(lateJoinBlocked, "late join must fail after ended");

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "freeplay",
        arena: arena.id,
        radiusM: arena.radiusM,
        plants,
        banks,
        cuts,
        top3: top.map((s) => ({
          nickname: s.nickname,
          areaM2: Math.round(s.areaM2),
        })),
        seats: [...lobby.seats.values()].map(seatPublicView),
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
