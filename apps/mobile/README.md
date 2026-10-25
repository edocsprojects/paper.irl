# paper.irl — mobile (Expo)

React Native (Expo) client sharing `@paper-irl/rules`. **Android** + **iOS** (native `ios/` for Xcode). Street map via MapLibre in a WebView (OpenFreeMap — **no Google Maps key**).

## Launch modes (one app, both platforms)

| Root script | Mode | Behavior |
|---|---|---|
| `pnpm mobile` / `pnpm mobile:ios` | `human` | Create/join lobby; real GPS when permitted; mock autopilot if GPS denied (simulator) |
| `pnpm mobile:join-bots` / `pnpm mobile:ios:join-bots` | `join-bots` | Join (or create) a lobby with 7 bots; **your seat is auto-moved** like the sim |
| `pnpm mobile:host-bots` / `pnpm mobile:ios:host-bots` | `host-bots` | Create lobby, fill 7 bots, start; your seat auto-moved for demo footage |

Always start the API first (`pnpm dev:server`).

Default API URL (override with `EXPO_PUBLIC_API_URL`):

| Client | URL |
|---|---|
| Android emulator | `http://10.0.2.2:3001` |
| iOS Simulator | `http://127.0.0.1:3001` |
| Physical device | `http://<your-lan-ip>:3001` |

---

## Metro monorepo (required reading)

Expo’s Metro **server root is the monorepo root**. AppDelegate must use:

```objc
jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"
```

Expo rewrites that to `apps/mobile/index` (from `"main": "index.js"`).  
**Do not** use `@"index"` — Metro looks for `<repo>/index.js` and redboxes.

Also: `.npmrc` `node-linker=hoisted`, `ios/.xcode.env` `ENTRY_FILE=index.js`, local `index.js` → `registerRootComponent(App)`.

### Linux gate (runs in cloud / `pnpm test`)

```bash
pnpm verify:mobile
# or: pnpm --filter @paper-irl/mobile verify:bundle
```

Catches: `@babel/runtime`, `expo/AppEntry` `../../App`, bare `./index` from repo root, stale `.pnpm` symlinks / autolinking paths, and (on macOS) `Podfile.lock` / `Pods` still pointing at `node_modules/.pnpm`. HTTP-probes virtual-metro-entry, `/apps/mobile/index.bundle`, and bare `/index.bundle` with Metro launched exactly like `pnpm mobile:ios:host-bots` (repo root + `pnpm --filter`).

`metro.config.js` also rewrites bare `/index.bundle` → `/apps/mobile/index.bundle`, so an old Simulator binary that still asks for `index` gets the app instead of the `./index` redbox.

### Stale native build (xcodebuild 65 / `ExpoModulesCore` pcm / `.pnpm/expo-modules-core@…`)

Pods + DerivedData built before `node-linker=hoisted` reference `node_modules/.pnpm/...` paths that no longer exist. The build fails, the **old** app stays on the Simulator, and it redboxes on `./index`. Fix:

```bash
pnpm mobile:ios:clean   # rm ios/Pods, Podfile.lock, ios/build, DerivedData/paperirl-*, uninstall irl.paper.demo
```

---

## iOS / Xcode (Mac) — after `pnpm verify:mobile` is green

Free Apple **Personal Team** is enough for **Simulator**. Paid **$99/yr** only for TestFlight / broader device distribution.

### Terminal 1 — API

```bash
git fetch && git checkout cursor/ios-xcode-2c59 && git pull && git log -1 --oneline
rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/mobile/.expo apps/mobile/.verify-export apps/mobile/.verify-export-from-root
pnpm install
pnpm --filter @paper-irl/rules build
pnpm mobile:ios:clean
pnpm verify:mobile
pnpm dev:server
```

### Terminal 2 — iOS

```bash
pnpm mobile:ios:host-bots
```

Or open Xcode after pods:

```bash
cd apps/mobile/ios && pod install && open paperirl.xcworkspace
```

Xcode → **paperirl** → iPhone Simulator → **Run** (rebuild so AppDelegate is current). If Xcode shows a pcm / `.pnpm` error, quit Xcode, run `pnpm mobile:ios:clean`, then `pod install` again.

MVP play is **freeplay GPS** inside the Keller 500 m circle (shared `@paper-irl/rules` + server). Trails/territory are freehand polylines — not OSM path-graph claims. Off-boundary fixes are soft-rejected/clamped by the server.

---

## Android Studio emulator

```bash
pnpm install
pnpm --filter @paper-irl/rules build
pnpm dev:server          # terminal 1
pnpm mobile:host-bots    # terminal 2
```

Same Metro stack as iOS — `pnpm verify:mobile` gates both. Browser escape hatch: `pnpm demo`.

## Project layout

```
apps/mobile/          Expo app (TS) + index.js entry
apps/mobile/ios/      Native Xcode project (open *.xcworkspace after pods)
apps/server/          HTTP lobby + bot loop
packages/rules/       Shared plant/trail/cut/wipe + wanderSeat
```
