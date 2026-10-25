# paper.irl — mobile (Expo)

React Native (Expo) client sharing `@paper-irl/rules`. **Android** (Expo Go) and **iOS** (native `ios/` for Xcode). Street map via MapLibre in a WebView (OpenFreeMap — **no Google Maps key**).

## Launch modes (one app, both platforms)

| Root script | Mode | Behavior |
|---|---|---|
| `pnpm mobile` / `pnpm mobile:ios` | `human` | Create/join lobby; real GPS when permitted; mock autopilot if GPS denied (simulator) |
| `pnpm mobile:join-bots` / `pnpm mobile:ios:join-bots` | `join-bots` | Join (or create) a lobby with 7 bots; **your seat is auto-moved** like the sim |
| `pnpm mobile:host-bots` / `pnpm mobile:ios:host-bots` | `host-bots` | Create lobby, fill 7 bots, start; your seat auto-moved for demo footage |

Always start the API first:

```bash
pnpm --filter @paper-irl/rules build
pnpm dev:server   # http://0.0.0.0:3001
```

Default API URL (override with `EXPO_PUBLIC_API_URL`):

| Client | URL |
|---|---|
| Android emulator | `http://10.0.2.2:3001` |
| iOS Simulator | `http://127.0.0.1:3001` |
| Physical device | `http://<your-lan-ip>:3001` |

---

## iOS / Xcode (Mac)

Cloud agents cannot run Xcode. Do this on your Mac. A **free Apple ID / Personal Team** is enough for the **Simulator**. The paid **Apple Developer Program ($99/yr)** is only needed for a physical device install beyond short personal runs, or **TestFlight**.

### One-time Mac setup

1. Install **Xcode** from the Mac App Store (includes Simulator). Open it once and accept the license.
2. Install Xcode CLT if prompted: `xcode-select --install`
3. Install **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`)
4. Node **20+** and pnpm: `corepack enable`

### After pulling this branch (Metro / iOS entry)

Under pnpm, `.expo/.virtual-metro-entry` still lands on `expo/AppEntry` (`../../App` breaks). Fix:

- `package.json` `"main": "index.js"` + local `index.js` → `./App`
- iOS `AppDelegate` DEBUG root = `index` (not virtual-metro-entry)
- `ios/.xcode.env` `ENTRY_FILE=index.js`
- `@babel/runtime` direct dep + `.npmrc` hoist

**Verify you have the fix, then clean install:**

```bash
git fetch && git checkout cursor/ios-xcode-2c59 && git pull && git log -1 --oneline
rm -rf node_modules apps/mobile/node_modules apps/mobile/.expo apps/mobile/.verify-export
pnpm install && pnpm --filter @paper-irl/rules build
pnpm --filter @paper-irl/mobile verify:bundle   # Linux-safe; must PASS
pnpm dev:server                                 # other terminal
pnpm mobile:ios:host-bots
```

### Open in Xcode and Run (Simulator)

From the **repo root**:

```bash
pnpm install
pnpm --filter @paper-irl/rules build
pnpm dev:server
```

In a **second** terminal, install pods and open the workspace:

```bash
cd apps/mobile/ios
pod install
open paperirl.xcworkspace
```

> Always open **`paperirl.xcworkspace`**, not the `.xcodeproj`. `pod install` creates the workspace (Pods are not committed).

In Xcode:

1. Top bar: select the **paperirl** scheme.
2. Pick an **iPhone simulator** (e.g. iPhone 16).
3. Signing: select your **Personal Team** (free Apple ID) under *Signing & Capabilities* if Xcode asks. Simulator builds work with Personal Team.
4. Press **Run** (▶) or `Cmd+R`.

Metro / JS: either leave Xcode’s build to start the bundler, or from repo root:

```bash
EXPO_PUBLIC_LAUNCH=host-bots pnpm --filter @paper-irl/mobile start
```

Then Run again in Xcode so the app loads that launch mode.

### CLI shortcut (no manual Xcode click)

With the server already running:

```bash
pnpm mobile:ios:host-bots   # builds, pods if needed, launches Simulator
# or: pnpm mobile:ios / pnpm mobile:ios:join-bots
```

### Regenerate `ios/` after changing `app.json`

```bash
pnpm mobile:prebuild:ios
# on Mac, then:
cd apps/mobile/ios && pod install
```

`apps/mobile/ios` is committed (without `Pods/`) so you can open Xcode without re-prebuilding on a clean clone. Re-run prebuild when native config or plugins change.

### Apple account cheat sheet

| Goal | Need |
|---|---|
| Run in **Simulator** | Free Apple ID / Personal Team |
| USB debug on your own iPhone (limited) | Free Personal Team (7-day cert; fiddly) |
| Friends via **TestFlight** / device distribution | Paid Apple Developer **$99/yr** |

---

## Android Studio emulator + demo footage

1. Install [Android Studio](https://developer.android.com/studio) → SDK + one Virtual Device (API 34+, Google APIs image is fine).
2. Install Node 20+, enable pnpm (`corepack enable`).
3. From repo root:

```bash
pnpm install
pnpm --filter @paper-irl/rules build
pnpm dev:server
```

4. In a second terminal:

```bash
pnpm mobile:host-bots
```

5. When Metro asks, press `a` (Android) or wait for the emulator to open the app.
6. In-app: tap **Create & start** — bots fill + match starts; your seat autopilots.
7. **Screen record for footage**
   - Emulator: `⋯` menu → **Record and Playback** → Start recording → Stop → Save.
   - Or CLI: `adb shell screenrecord /sdcard/paper.mp4` then `adb pull /sdcard/paper.mp4`.

### Human GPS on emulator

Extended Controls (`⋯`) → **Location** → set a single point near Keller Hall (`44.97452, -93.23256`) or play a GPX route. Then use `pnpm mobile` and grant location.

## Project layout

```
apps/mobile/          Expo app (TS)
apps/mobile/ios/      Native Xcode project (prebuild; open *.xcworkspace after pods)
apps/server/          HTTP lobby + bot loop
packages/rules/       Shared plant/trail/cut/wipe + wanderSeat
```
