# paper.irl

IRL [paper.io](https://paper.io)-style territory game. **MVP is freeplay GPS** inside a campus boundary (classic trail / bank / cut) — not OSM path-graph claims. First demo map: **Kenneth H. Keller Hall** (UMN), **500 m** circle, **15 min** lobbies, max **8** players.

## Monorepo

```
apps/mobile    Expo Android + iOS client (human / join-bots / host-bots)
apps/web       Street-map freeplay demo — 8 bots wander the Keller circle
apps/server    HTTP API + bot loop (optional Postgres)
apps/sim       8-bot mock GPS simulation (verification harness)
packages/rules Pure freeplay rules + optional Keller OSM graph loader (deferred)
data/keller    Optional OSM paths (basemap / later modes — not required for MVP play)
docs/          MVP rules summary
```

## Quick start (local, no cloud)

```bash
pnpm install
pnpm demo          # browser UI: freeplay + timer + P1 spawn (http://localhost:5173)
pnpm test          # rules unit tests + headless freeplay sim
pnpm sim:lobby     # 8 mocked players wandering Keller circle
pnpm dev:server    # API on :3001 (DATABASE_URL optional)
```

### Android (Expo Go)

```bash
pnpm dev:server                 # terminal 1
pnpm mobile                     # human lobby (GPS or emulator mock)
pnpm mobile:join-bots           # 7 bots + autopilot your seat
pnpm mobile:host-bots           # create, fill 7 bots, start, autopilot you
```

Android emulator API URL defaults to `http://10.0.2.2:3001`.

### iOS / Xcode (Mac)

```bash
pnpm install
pnpm --filter @paper-irl/rules build
pnpm dev:server                 # terminal 1
cd apps/mobile/ios && pod install && open paperirl.xcworkspace
```

In Xcode: pick an **iPhone Simulator** → **Run** (▶). Free **Personal Team** is enough for Simulator; paid Apple Developer ($99) only for TestFlight / broader device distribution.

CLI: `pnpm mobile:ios` / `pnpm mobile:ios:join-bots` / `pnpm mobile:ios:host-bots` (same three modes; Simulator API default `http://127.0.0.1:3001`).

If Metro fails with `Unable to resolve "@babel/runtime/..."`: `pnpm install && pnpm mobile:ios:host-bots` (with `pnpm dev:server` already running).

Full Mac steps: [`apps/mobile/README.md`](apps/mobile/README.md).

No Google Maps key needed. Claims are freehand GPS polylines inside the lobby boundary; the basemap is a simple street map (OpenFreeMap). Camera follows Player 1 (“You”); tap anywhere on the Spawn overlay to plant / respawn while other bots keep wandering.

Optional Postgres:

```bash
docker compose up -d
export DATABASE_URL=postgres://paper:paper@localhost:5432/paper_irl
```

Package name for rules is `@paper-irl/rules`.

## What is verified today

| Check | Command | Expect |
|---|---|---|
| Plant only at marker | `pnpm test` | Cannot claim until plant |
| Cut → wipe → neutral land → respawn | `pnpm test` | Victim area 0, must re-plant |
| Boundary soft-push | `pnpm test` | Off-circle fixes clamped |
| Top 3 by area at end | `pnpm test` | Sorted ranking |
| 8-bot free wander / cut / respawn | `pnpm sim:lobby` | Exit 0 + JSON summary |
| Watchable campus match | `pnpm demo` | Street map, boundary circle, freehand territory |
| Server bots fill/start | `pnpm dev:server` + curl | See mobile README |

## MVP product locks

- **Freeplay GPS** inside the lobby boundary (circle now; polygon later). Off-boundary rejected / soft-pushed.
- Trails / claims / cuts use **freehand lat/lon polylines** (paper.io-style). OSM path graph is **deferred / optional** (basemap only for now).
- Host Start, nicknames, always-visible opponents, area score, land → neutral on death, nearest safe respawn (moves if contested).
- Local demo needs no Google key. Cloud (Railway/Supabase) not required for local sim/tests.

## API sketch

- `POST /lobbies` → `{ code }`
- `POST /lobbies/:code/join` `{ nickname }`
- `POST /lobbies/:code/bots/fill` `{ leaveHumanSlots? }`
- `POST /lobbies/:code/start` (starts bot tick loop)
- `POST /lobbies/:code/fix` `{ seatId, fix }`
- `POST /lobbies/:code/autopilot` `{ seatId }` — sim step for one seat
- `GET /lobbies/:code` → arena + seats + top3 (freeplay)

## License

Private / TBD.
