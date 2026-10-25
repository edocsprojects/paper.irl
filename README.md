# paper.irl

IRL [paper.io](https://paper.io)-style territory game on campus roads/paths. First demo map: **Kenneth H. Keller Hall** (UMN), **500 m** radius, **15 min** lobbies, max **8** players.

## Monorepo

```
apps/server   HTTP API + in-memory lobby (optional Postgres)
apps/sim      8-bot mock GPS simulation (verification harness)
packages/rules  Pure game logic + Keller fixture graph
docs/         MVP rules summary
```

## Quick start (local, no cloud)

```bash
pnpm install
pnpm test          # rules unit tests
pnpm sim:lobby     # 8 mocked players on Keller fixture
pnpm dev:server    # API on :3001 (DATABASE_URL optional)
```

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

## MVP product locks

- Host Start, nicknames, always-visible opponents, area score, land → neutral on death, nearest safe respawn (moves if contested).
- Google Maps UI comes later (needs Android Maps API key). Logic does not need Google.
- Cloud (Railway/Supabase) not required for local sim/tests.

## API sketch

- `POST /lobbies` → `{ code }`
- `POST /lobbies/:code/join` `{ nickname }`
- `POST /lobbies/:code/start`
- `POST /lobbies/:code/fix` `{ seatId, fix }`
- `GET /lobbies/:code` → seats + top3

## License

Private / TBD.
