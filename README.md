# paper.irl

IRL [paper.io](https://paper.io)-style territory game. **MVP is freeplay GPS** inside a campus boundary (classic trail / bank / cut) — not OSM path-graph claims. First demo map: **Kenneth H. Keller Hall** (UMN), **500 m** circle, **15 min** lobbies, max **8** players.

## Monorepo

```
apps/mobile    Expo Android + iOS client (human / join-bots / host-bots)
apps/web       Web app: sign-in, live 7-day GPS event, ranks, settings (+ bot demo mode)
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

### Web app (live GPS event)

```bash
cp .env.example .env   # fill SUPABASE_* / VITE_SUPABASE_* for Google sign-in (optional; guests work without)
pnpm dev:server        # terminal 1 — hosts the 7-day event
pnpm demo              # terminal 2 — http://localhost:5173 (proxies /api → :3001)
pnpm demo:phone        # same over HTTPS on your LAN; phones only allow GPS on https
```

- **Real GPS** (default): Let's Claim joins the current event; your first fix plants your base where you stand. Fixes outside the dashed circle are drawn for you in gray but never sent, so they can't score.
- **Demo simulation** (Settings → Game mode): local bots, 1×–20× (1× ≈ jogging pace).
- The event runs **7 days**; at the end the top player is recorded as winner and a new event starts. State persists in Postgres (`DATABASE_URL`) or `data/event/*.json`. Shorten with `EVENT_DURATION_MS` for testing.
- Google sign-in goes through Supabase Auth; the server verifies the player's token before accepting fixes.

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

Metro monorepo gate (required before Simulator): `pnpm verify:mobile` (also part of `pnpm test`). After switching branches / reinstalling, wipe stale Pods + DerivedData with `pnpm mobile:ios:clean`.

Full Mac two-terminal steps: [`apps/mobile/README.md`](apps/mobile/README.md).

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
- `GET /event` → current 7-day event (seats, endsAt, last winner)
- `POST /event/join` `{ name }` — join / rename (auth: `Authorization: Bearer <supabase token>` or `X-Guest-Id`)
- `POST /event/fix` `{ fix }` — inside-circle GPS fix; outside fixes return `{ outside: true }` and are ignored
- `GET /event/results` → recent winners

## License

Private / TBD.
