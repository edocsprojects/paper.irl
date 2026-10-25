# MVP rules (Keller Hall) — freeplay GPS

Short product rules for implementers. Full plan lives in the project agent store.

## Match

- Map: Kenneth H. Keller Hall center, **500 m** circular **boundary**. Players move **freely** inside it (off-boundary soft-pushed back).
- Claims / trails / cuts: **freehand GPS polylines** (classic paper.io), **not** snapped OSM edges.
- OSM path graph is **deferred / optional** (may remain as basemap or a later mode). Not required for MVP play.
- Lobby: create → nickname → join code → host **Start**. Max **8**. **15 minutes**. No late join.
- Everyone always sees everyone else (position / trail / color).
- Score: **area held** (enclosed freehand polygons; thin out-and-backs ≈ trail length × ~5 m corridor). Results: **top 3**.
- Cut: proximity (~15 m) to an open trail. Wiped land is **fully neutral** (cutter does not auto-steal). Walk/run only — **no cars**.
- Infra now: one Postgres OK; Redis/multi-instance later. Minors/night/public deferred.
- Local watchable demo: `pnpm demo` — street basemap, boundary circle, P1 camera, Spawn/respawn (**tap anywhere**), top 3, snackbars.

## Loop

1. Reach plant / respawn marker → plant small starter disk.
2. Leave your color → freehand trail.
3. Return to your color → bank (claim enclosed area / corridor).
4. Step near someone’s open trail → they **wipe**: land goes **neutral**, they ghost to a **nearest safe** respawn marker, and cannot claim until they plant again.
5. If that marker becomes unsafe, it **moves**.

## Local stack

- Node server + rules package + Docker Postgres (optional for sim).
- `pnpm demo` — MapLibre street UI + freeplay + P1 spawn + 8 wandering bots.
- `pnpm sim:lobby` — 8 mocked bots with synthetic free GPS in the Keller circle.
- `pnpm test` — unit rules tests.
