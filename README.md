# paper.irl

IRL [paper.io](https://paper.io)-style territory game on campus roads/paths. First demo map: **Kenneth H. Keller Hall** (UMN), **500 m** radius, **15 min** lobbies, max **8** players.

## Monorepo

```
apps/web      Satellite map demo — 8 bots on real OSM paths (Keller Hall)
apps/server   HTTP API + in-memory lobby (optional Postgres)
apps/sim      8-bot mock GPS simulation (verification harness)
packages/rules  Pure game logic + Keller fixture / OSM graph loader
data/keller   Compiled OSM playable graph (keller-osm-v1)
docs/         MVP rules summary
```

## Quick start (local, no cloud)

```bash
pnpm install
pnpm demo          # browser UI: street map + timer + P1 spawn (http://localhost:5173)
pnpm test          # rules unit tests + headless sim
pnpm sim:lobby     # 8 mocked players on Keller fixture (CI harness)
pnpm dev:server    # API on :3001 (DATABASE_URL optional)
```

No Google Maps key needed. Paths come from OpenStreetMap; the basemap is a simple street map (OpenFreeMap). Camera follows Player 1 (“You”); tap anywhere on the Spawn overlay to plant / respawn while other bots keep running.

Optional Postgres:

```bash
docker compose up -d
export DATABASE_URL=postgres://paper:paper@localhost:5432/paper_irl
pnpm dev:server
```

## What is verified today

| Check | Command | Expect |
|---|---|---|
| Plant only at marker | `pnpm test` | Cannot claim until plant |
| Cut → wipe → neutral land → respawn | `pnpm test` | Victim area 0, must re-plant |
| Top 3 by area at end | `pnpm test` | Sorted ranking |
| 8-bot random walk / cut / respawn | `pnpm sim:lobby` | Exit 0 + JSON summary |
| Watchable campus match | `pnpm demo` | Street map, P1 camera, spawn, top 3, snackbars |

## MVP product locks

- Host Start, nicknames, always-visible opponents, area score, land → neutral on death, nearest safe respawn (moves if contested).
- Playable paths: **OpenStreetMap** (claim truth). Phone UI later may use Google or MapLibre for look; logic stays on OSM.
- Local satellite demo needs no Google key. Cloud (Railway/Supabase) not required for local sim/tests.

## API sketch

- `POST /lobbies` → `{ code }`
- `POST /lobbies/:code/join` `{ nickname }`
- `POST /lobbies/:code/start`
- `POST /lobbies/:code/fix` `{ seatId, fix }`
- `GET /lobbies/:code` → seats + top3

## License

Private / TBD.
