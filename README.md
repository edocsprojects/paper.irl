# paper.irl

IRL [paper.io](https://paper.io)-style territory game. **MVP is freeplay GPS** inside a campus boundary (classic trail / bank / cut) — not OSM path-graph claims. First demo map: **Kenneth H. Keller Hall** (UMN), **500 m** circle, **15 min** lobbies, max **8** players.

## Monorepo

```
apps/web      Street-map freeplay demo — 8 bots wander the Keller circle
apps/server   HTTP API + in-memory lobby (optional Postgres)
apps/sim      8-bot mock GPS simulation (verification harness)
packages/rules  Pure freeplay rules + optional Keller OSM graph loader (deferred)
data/keller   Optional OSM paths (basemap / later modes — not required for MVP play)
docs/         MVP rules summary
```

## Quick start (local, no cloud)

```bash
pnpm install
pnpm demo          # browser UI: freeplay + timer + P1 spawn (http://localhost:5173)
pnpm test          # rules unit tests + headless freeplay sim
pnpm sim:lobby     # 8 mocked players wandering Keller circle
pnpm dev:server    # API on :3001 (DATABASE_URL optional)
```

No Google Maps key needed. Claims are freehand GPS polylines inside the lobby boundary; the basemap is a simple street map (OpenFreeMap). Camera follows Player 1 (“You”); tap anywhere on the Spawn overlay to plant / respawn while other bots keep wandering.

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
| Boundary soft-push | `pnpm test` | Off-circle fixes clamped |
| Top 3 by area at end | `pnpm test` | Sorted ranking |
| 8-bot free wander / cut / respawn | `pnpm sim:lobby` | Exit 0 + JSON summary |
| Watchable campus match | `pnpm demo` | Street map, boundary circle, freehand territory |

## MVP product locks

- **Freeplay GPS** inside the lobby boundary (circle now; polygon later). Off-boundary rejected / soft-pushed.
- Trails / claims / cuts use **freehand lat/lon polylines** (paper.io-style). OSM path graph is **deferred / optional** (basemap only for now).
- Host Start, nicknames, always-visible opponents, area score, land → neutral on death, nearest safe respawn (moves if contested).
- Local demo needs no Google key. Cloud (Railway/Supabase) not required for local sim/tests.

## API sketch

- `POST /lobbies` → `{ code }`
- `POST /lobbies/:code/join` `{ nickname }`
- `POST /lobbies/:code/start`
- `POST /lobbies/:code/fix` `{ seatId, fix }`
- `GET /lobbies/:code` → seats + top3

## License

Private / TBD.
