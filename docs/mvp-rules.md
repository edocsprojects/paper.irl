# MVP rules (Keller Hall) — freeplay GPS

Short product rules for implementers. Full plan lives in the project agent store.

## Match

- Map: circular **boundary** centred on the **host's GPS position** when the lobby is created (Keller Hall is only the fallback). Players move **freely** inside it (off-boundary soft-pushed back).
- Claims / trails / cuts: **freehand GPS polylines** (classic paper.io), **not** snapped OSM edges.
- OSM path graph is **deferred / optional** (may remain as basemap or a later mode). Not required for MVP play.
- Lobby: create → nickname → join code → host **Start**. Max **8**. **15 minutes**. No late join.
- Everyone always sees everyone else (position / trail / color).
- Score: **area held** — real (concave) polygons, shown as % of the arena. Results: **top 3**.
- Capture: returning home unions your trail corridor (~5 m wide) with your land and **fills everything it encloses**, taking that ground from anyone who held it. Lose all your land → you're eliminated.
- Cut: touching (≤ ~4 m, or stepping across) **anyone's** open trail — even from inside your own land — eliminates its owner. Crossing **your own** trail is allowed. Wiped land is **fully neutral**. Walk/run only — **no cars** (>8 m/s fixes rejected).
- Infra now: one Postgres OK; Redis/multi-instance later. Minors/night/public deferred.
- Mobile bot demo: `EXPO_PUBLIC_LAUNCH=host-bots` — auto-hosts a 2.5× speed match, player 1 auto-walks, bots spread across the arena. Display units are imperial (ft / ft²); the server works in metres.
- Local watchable demo: `pnpm demo` — street basemap, boundary circle, P1 camera, Spawn/respawn (**tap anywhere**), top 3, snackbars.

## Loop

1. Tap **Spawn** → your 22 m starter disk is planted **where you stand** (if that spot is within ~8 m of anyone's land/trail/body, a marker shows the nearest clear spot; it plants when you arrive). A starter never overlaps another zone.
2. Leave your color → freehand trail (in your colour) follows you.
3. Return to your color → bank (fill the enclosed area).
4. Get cut / lose all land → **ghost for 3 s** where you are (no teleport). Your **respawn ring** appears right away ~2 radii from where you fell; walk into it and you're planted again (no tap).
5. Every elimination shows in the **kill feed** and as a burst on the map.

## Local stack

- Node server + rules package + Docker Postgres (optional for sim).
- `pnpm demo` — MapLibre street UI + freeplay + P1 spawn + 8 wandering bots.
- `pnpm mobile` / `mobile:join-bots` / `mobile:host-bots` — Expo Android (see `apps/mobile/README.md`).
- `pnpm sim:lobby` — 8 mocked bots with synthetic free GPS in the Keller circle.
- `pnpm test` — unit rules tests.
