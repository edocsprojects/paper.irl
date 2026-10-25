# paper.irl — mobile (Expo)

React Native (Expo) client sharing `@paper-irl/rules`. **Android** + **iOS**.

**Play view:** street MapLibre basemap with **labels and MapLibre logo hidden** (road geometry kept; smallest OSM © credit). Camera locked to you with smooth lerp. RN HUD overlays the map.

**Lobby UX:** Home → Create (config: lat/lon `44.97452, -93.23256`, radius, max) → **Create** opens a lobby with a **random 6-char code** and bots in empty seats → host **Start** → 3-2-1. Join enters that code and sees the same lobby card. Brand: `paper.irl`.

## Fast Refresh

JS/TS under `apps/mobile` updates via Metro Fast Refresh. Do **not** `rm -rf node_modules` every run. Native rebuild only for ios/Pods/plugins.

Day-to-day: leave `pnpm dev:server` + Metro running; `git pull` then press `r` in Metro if needed.

## Scripts

Always start the API first (`pnpm dev:server`).

| Client | Default API |
|---|---|
| iOS Simulator | `http://127.0.0.1:3001` |
| Android emulator | `http://10.0.2.2:3001` |

### Terminal 1 — API

```bash
git fetch && git checkout cursor/mobile-lobby-ui-8b8c && git pull
pnpm install
pnpm --filter @paper-irl/rules build
pnpm verify:mobile
pnpm dev:server
```

### Terminal 2 — iOS

```bash
pnpm mobile:ios:host-bots
```

## Data path

HTTP poll `GET /lobbies/:code` (~1s) + autopilot/fix POSTs. No websocket.
