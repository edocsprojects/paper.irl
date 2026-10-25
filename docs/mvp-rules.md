# MVP rules (Keller Hall)

Short product rules for implementers. Full plan lives in the project agent store.

## Match

- Map: Kenneth H. Keller Hall center, **500 m** radius. Playable graph: **OSM roads/paths** (`data/keller/graph.json`). Unit tests still use a dense fixture grid.
- Lobby: create → nickname → join code → host **Start**. Max **8**. **15 minutes**. No late join.
- Everyone always sees everyone else (position / trail / color).
- Score: **area held** (path length × ~5 m + enclosed blocks). Results: **top 3**.
- Cut: wiped land is **fully neutral** (cutter does not auto-steal). Walk/run only — **no cars**.
- Infra now: one Postgres OK; Redis/multi-instance later. Minors/night/public deferred.
- Local watchable demo: `pnpm demo` — street basemap, P1 camera, Spawn/respawn (**tap anywhere**), top 3, snackbars.

## Loop

1. Reach plant / respawn marker → plant small starter.
2. Leave your color → trail.
3. Return to your color → bank (claim trail). Closing a block counts as area.
4. Step on someone’s open trail → they **wipe**: land goes **neutral**, they ghost to a **nearest safe** respawn marker, and cannot claim until they plant again.
5. If that marker becomes unsafe, it **moves**.

## Local stack

- Node server + rules package + Docker Postgres (optional for sim).
- `pnpm demo` — MapLibre street UI + OSM paths + P1 spawn + 8 bots.
- `pnpm sim:lobby` — 8 mocked bots with synthetic GPS (fixture graph).
- `pnpm test` — unit rules tests.
