# paper.irl — Android mobile (Expo)

React Native (Expo) client sharing `@paper-irl/rules`. Android-first. Street map via MapLibre in a WebView (OpenFreeMap — **no Google Maps key**).

## Launch modes (one app)

| Script | Mode | Behavior |
|---|---|---|
| `pnpm mobile` | `human` | Create/join lobby; real GPS when permitted; mock autopilot if GPS denied (emulator) |
| `pnpm mobile:join-bots` | `join-bots` | Join (or create) a lobby with 7 bots; **your seat is auto-moved** like the sim |
| `pnpm mobile:host-bots` | `host-bots` | Create lobby, fill 7 bots, start; your seat auto-moved for demo footage |

Always start the API first:

```bash
pnpm --filter @paper-irl/rules build
pnpm dev:server   # http://0.0.0.0:3001
```

Emulator reaches the host via `http://10.0.2.2:3001` (default `EXPO_PUBLIC_API_URL`). Physical device: set `EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3001`.

## Android Studio emulator + demo footage

1. Install [Android Studio](https://developer.android.com/studio) → SDK + one Virtual Device (API 34+, Google APIs image is fine).
2. Install Node 20+, enable pnpm (`corepack enable`).
3. From repo root:

```bash
pnpm install
pnpm --filter @paper-irl/rules build
pnpm dev:server
```

4. In a second terminal, start Expo against the emulator:

```bash
pnpm mobile:host-bots
```

5. When Metro asks, press `a` (Android) or wait for the emulator to open the app.
6. In-app: tap **Create & start** — bots fill + match starts; your seat autopilots.
7. **Screen record for footage**
   - Emulator: `⋯` menu → **Record and Playback** → Start recording → Stop → Save.
   - Or CLI: `adb shell screenrecord /sdcard/paper.mp4` then `adb pull /sdcard/paper.mp4`.
   - Or Android Studio’s emulator camera/record controls.

### Human GPS on emulator

Extended Controls (`⋯`) → **Location** → set a single point near Keller Hall (`44.97452, -93.23256`) or play a GPX route. Then use `pnpm mobile` and grant location.

## Project layout

```
apps/mobile/          Expo app
apps/server/          HTTP lobby + bot loop
packages/rules/       Shared plant/trail/cut/wipe + wanderSeat
```
