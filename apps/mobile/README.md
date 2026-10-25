# paper.irl — mobile (Expo)

React Native (Expo) client sharing `@paper-irl/rules`. **Android** + **iOS** (native `ios/` for Xcode).

**Play view:** plain RN arena (lat/lon → local meters, camera locked to you, lerped positions). **No MapLibre / WebView map.**

**Lobby UX:** Home → Create (one setup: GPS lat/lon, radius, max, Start) or Join (`ABC123`). Start fills bots + **3-2-1** countdown. Brand text is exactly `paper.irl`.

## Scripts

| Root script | Notes |
|---|---|
| `pnpm mobile` / `pnpm mobile:ios` | Human GPS when permitted; autopilot if denied |
| `pnpm mobile:ios:host-bots` | Same app; useful for Simulator footage |

Always start the API first (`pnpm dev:server`).

Default API URL (override with `EXPO_PUBLIC_API_URL`):

| Client | URL |
|---|---|
| Android emulator | `http://10.0.2.2:3001` |
| iOS Simulator | `http://127.0.0.1:3001` |
| Physical device | `http://<your-lan-ip>:3001` |

---

## Fast Refresh

JS/TS under `apps/mobile` (screens, arena, HUD) updates via Metro Fast Refresh — **save and Simulator updates**. No Xcode/Pods restart.

Rebuild native only when you change `ios/`, Podfile, native modules, or app.json plugins. Do **not** `rm -rf node_modules` on every run.

---

## Metro monorepo (required reading)

Expo’s Metro **server root is the monorepo root**. AppDelegate must use:

```objc
jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"
```

### Linux gate

```bash
pnpm verify:mobile
```

### Stale native build

Only if AST/Pods/pcm break:

```bash
pnpm mobile:ios:clean
```

---

## iOS Simulator (Mac) — after `pnpm verify:mobile` is green

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

---

## Data path (play)

HTTP poll `GET /lobbies/:code` (~1s) + GPS/autopilot `POST` snapshots. No websocket. RN + arena skip redundant identical fingerprints; positions lerp on the client.
