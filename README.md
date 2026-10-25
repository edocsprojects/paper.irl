# paper.irl

IRL [paper.io](https://paper.io): you move your body instead of a square. Leave your territory to draw a trail, loop back to claim everything it encloses, and cut other players by touching their trails. Freeplay GPS inside a circular zone (default demo spot: **Kenneth H. Keller Hall**, UMN), up to **8** players.

## Monorepo

```
apps/web       Web app (main demo): sign-in, Home (Create / Join / Community Events),
               lobby, game HUD, results, Settings (Real GPS / Simulation)
apps/mobile    Expo React Native client (iOS / Android), real GPS + bot demo
apps/server    Fastify HTTP API: lobbies, bot loop, three 1-hour community events, optional Postgres / Supabase auth
apps/sim       Headless 8-bot simulation (verification harness)
packages/rules Pure game rules (territory, cuts, respawn, bots) shared by everything
docs/          MVP rules summary (docs/mvp-rules.md)
```

## Quick start (web demo)

```bash
pnpm install
pnpm dev:server    # terminal 1 — API on :3001 (builds packages/rules first)
pnpm demo          # terminal 2 — web app on http://localhost:5173 (proxies /api → :3001)
```

Then:

1. **Continue as a guest** (you get a random 12-character name; sign in to change it).
2. **Settings → Game mode → Simulation**, pick a speed (1× ≈ jogging pace, up to 20×).
3. **Home → Create game → Create** — the lobby fills as players join over a few seconds; tap **Start**, then you auto-walk and the camera follows you.

Use **Real GPS** mode to play outside: Create puts you in a lobby with a 6-letter code friends enter under **Join game**; the host taps **Start**, then you **Tap to spawn** where you stand. Phones only allow GPS on HTTPS — use `pnpm demo:phone` and open the LAN address it prints.

**Community Events** lists three public 1-hour events — **Keller Hall · UMN**, **North Loop** (300 Washington Ave N, Minneapolis) and **Millennium Park · Chicago** — each with score / rank, countdown, live map and **Let's Claim!!**. Each restarts when its hour is up. In Simulation they run locally with bots; in Real GPS they use the server events.

## Game rules (packages/rules)

- **Spawn** where your GPS is; a starter disk (22 m / 72 ft) is planted there, always with clear ground from anyone else's land, trails and bodies. Bots without GPS are spread evenly across the arena.
- **Trail**: leaving your land draws a trail (dashed line in your colour).
- **Claim**: walking back into your land fills **everything the loop encloses** (real polygons, not a convex hull) and takes that ground from whoever held it. Lose all your land → you're eliminated.
- **Cut**: touching (≈4 m, or stepping across) **anyone's** open trail eliminates its owner — even from inside your own land. Crossing your own trail is allowed.
- **Bots** move like people: they walk around blocks along a street grid (straight legs, corners), each at their own pace, slow down at turns, pause now and then, and report slightly drifting GPS fixes.
- **Death**: your land goes neutral and you're out for 3 s. A **respawn ring** appears ~2 radii from where you fell; walk into it and you're back in. While you're out the snackbar says to head back to your spawn area.
- Units in the UI are imperial (ft / ft²); the rules and server work in metres.

Full summary: [`docs/mvp-rules.md`](docs/mvp-rules.md).

## Web app (apps/web)

- Design: teammate's light theme (Manrope), illustrated sign-in (animated loop-and-claim) and Home art; Home / Stats / Settings tabs always visible.
- Stats: this week (distance, land, games + daily bars), personal records, all-time totals and recent games (stored on the device).
- While a game runs, Home shows a small **Back to game · time ›** link in the header.
- Flow: sign-in → Home (**Create game** / **Join game** / **Community Events**) → Create config (radius 500 / 1,000 / 1,500 ft, max players, 5 / 10 / 15 min) → lobby card → 3-2-1 → full-screen game → results leaderboard (Play again / Leave).
- Game HUD: top-3 board (% of arena), timer, **Zoom in / Zoom out**, red **Leave**, kill feed. Snackbar is only about you (claims, land taken, cuts you made, raid alerts, lead changes, 1 minute left) and fades after 3 s; it stays up while you're outside the circle or out after a cut. Games last at most 1 hour.
- Map: OpenFreeMap streets with labels, POIs and transit stripped; no API key needed.
- Google sign-in (optional): `cp .env.example .env` and fill `SUPABASE_*` / `VITE_SUPABASE_*`. Guests work without it.

## Mobile app (apps/mobile)

Expo React Native client with real GPS (`expo-location`), the in-game HUD (leaderboard, timer, zoom, leave), kill feed, respawn rings and death / spawn animations. It still uses the earlier dark design; the web design is the target for a follow-up restyle.

```bash
pnpm dev:server                     # terminal 1
pnpm mobile:ios                     # human lobby (Simulator API: http://127.0.0.1:3001)
pnpm mobile:ios:host-bots           # auto-host a 2.5× bot match; player 1 auto-walks
pnpm mobile / mobile:host-bots      # Android (emulator API: http://10.0.2.2:3001)
```

Physical device: set `EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3001`. iOS via Xcode: `pnpm --filter @paper-irl/rules build`, then `cd apps/mobile/ios && pod install && open paperirl.xcworkspace`. If Metro serves stale code, restart it with `--clear`. More: [`apps/mobile/README.md`](apps/mobile/README.md).

## Tests

```bash
pnpm test        # rules unit tests (vitest) + headless 8-bot sim + mobile bundle / map checks
pnpm typecheck   # all packages
```

`pnpm test` covers capture/steal/elimination, cuts (incl. sweep and from inside your land), respawn rings, spawn placement, 8-bot soaks (exclusive land, no stuck bots, fast ticks, demo pace), and `apps/mobile/scripts/verify-map-runtime.js`, which runs the real map page against MapLibre's style validation (with a sabotage self-check).

Optional Postgres for the server:

```bash
docker compose up -d
export DATABASE_URL=postgres://paper:paper@localhost:5432/paper_irl
```

## API sketch (apps/server)

- `POST /lobbies` `{ centerLat, centerLon, radiusM, maxSeats, durationMs, speedScale? }` → `{ code, arena }`
- `POST /lobbies/:code/join` `{ nickname }` (blank → "Player N")
- `POST /lobbies/:code/bots/fill` `{ leaveHumanSlots? }`
- `POST /lobbies/:code/start`
- `POST /lobbies/:code/fix` `{ seatId, fix }` → effects + lobby state
- `POST /lobbies/:code/autopilot` `{ seatId, autoPlant? }` — dev autopilot step
- `POST /lobbies/:code/rematch/ready` · `POST /lobbies/:code/rematch/start` `{ seatId }`
- `GET /lobbies/:code` → arena, seats (territory polygons, trails, respawn rings), top3, kill `feed`, land `notices`, spawn `pops`
- `GET /events` → the three 1-hour community events (`keller`, `north-loop`, `chicago`) with time left and player counts
- `GET /events/:id` · `POST /events/:id/join` `{ name }` · `POST /events/:id/fix` `{ fix }` · `GET /events/:id/results` (auth: `Authorization: Bearer <supabase token>` or `X-Guest-Id`); `/event/*` is an alias for Keller Hall

## License

Private / TBD.
