# Ruled

Local-first spaced-repetition notecards for macOS, iOS/iPadOS and Android (and any browser). Ruled schedules cards with **Anki's own algorithm** and syncs **device to device, with no server to run**.

## What's in it

- **Anki's v3 scheduler (SM-2)**, ported line by line from Anki's Rust source (`rslib/src/scheduler/states/*`, `answering/*`):
  - learning and relearning steps, including the hard-on-first-step averaging rule
  - graduating and easy intervals, ease changes (−20 / −15 / +15, floor 130%), hard/easy multipliers, interval modifier, late-review bonus, early-review rules
  - Anki's interval **fuzz** (same ranges, seeded per card from id + reps, so the button preview matches what you actually get) and learning-step fuzz
  - learning steps that cross the 4 AM day rollover become interday learning cards
  - leech threshold (8, then every 4 lapses after), tag or suspend
  - daily new/review limits (the review limit also caps new cards, as in v3), new/review mixing, a 20-minute learn-ahead
  - all of Anki's deck options, with Anki's defaults
- Notes: Basic, Basic + reversed, and Cloze (`{{c1::answer::hint}}`), with Markdown formatting
- Study screen with keyboard shortcuts (`space`, `1`–`4`, `z` undo, `e` edit, `-` bury, `@` suspend), a card browser with search, tag (`#tag`) and state filters, suspend/forget, stats (year heatmap, 30-day forecast, true retention), and import from text/CSV (Anki's "Notes in Plain Text" export works)
- Light and dark themes

## Sync without a server

Data lives in each device's local database (IndexedDB). Every record carries a **hybrid logical clock**, so edits merge with last-writer-wins and review history is never lost.

1. On one device: **Sync → Create a circle**. You get a 20-character code.
2. On your other devices: **Sync → Join**, then enter the code.
3. Any two devices in the circle that are open at the same time sync automatically, and keep syncing live.

Devices find each other through **public Nostr relays**, using [trystero](https://github.com/dmotz/trystero). The relays only see an encrypted handshake for a room whose name is derived from a hash of your code. Card data travels **directly between devices** over an encrypted WebRTC data channel. Changes also hop between devices: if A and C are never online at the same time, B carries changes between them.

If two devices can never connect directly (some strict NATs or carrier networks), use **Export backup / Import & merge** with any file-sync tool, such as iCloud Drive, Syncthing, or AirDrop. Importing merges and never overwrites newer data.

Advanced: to use your own relays, run `localStorage.setItem('ruled:relays', 'wss://your.relay')` in the dev console.

## Install

**Android:** install `release/Ruled.apk` (allow "install unknown apps").

**macOS:** run the GitHub Actions workflow (runs on every push to `main`; or **Actions → Build apps → Run workflow**) and download the `.dmg` artifact. To build locally instead:

```bash
npm install
npx tauri build
```

The app is unsigned. On first launch, right-click it and choose **Open**, or run:

```bash
xattr -cr /Applications/Ruled.app
```

**iPhone / iPad (iOS 15+):** Ruled isn't on the App Store, and Apple only lets signed apps onto a device. CI always builds an unsigned **Simulator** app (artifact `Ruled-iOS-Simulator`), and a signed `.ipa` (artifact `Ruled-iOS`) when you've set up signing. Your options, cheapest first:

1. **Xcode with a free Apple ID (sideload, no CI secrets).** On a Mac with Xcode and the Rust iOS target (`rustup target add aarch64-apple-ios`):
   ```bash
   brew install xcodegen
   npm install
   npx tauri ios init
   npx tauri ios build --open   # opens Xcode
   ```
   In Xcode: select the `ruled_iOS` target → **Signing & Capabilities** → tick *Automatically manage signing*, pick your Personal Team, and change the bundle identifier if `app.ruled.notecards` is taken. Plug in the iPhone, choose it as the run destination and press Run. On the phone, trust the developer under **Settings → General → VPN & Device Management** (and turn on **Developer Mode** under Privacy & Security, iOS 16+). Free-account apps **expire after 7 days**; run it from Xcode again to renew. Your cards survive a reinstall as long as you don't delete the app.
2. **AltStore / SideStore** (free Apple ID, no Xcode): download a signed-by-nobody `.ipa`… which CI only produces with signing secrets, so in practice build one with option 1 (**Product → Archive**, export) and open it in AltStore. AltStore re-signs it with your Apple ID and refreshes the 7-day signature in the background over Wi-Fi.
3. **Paid Apple Developer account ($99/yr) + CI.** Signatures last a year. Either register your devices' UDIDs and use an **Ad Hoc** profile (install the `.ipa` with Apple Configurator, Finder, or Xcode's *Devices* window), or use an **App Store** profile and let CI push every `main` build to **TestFlight** (install with the TestFlight app; builds last 90 days, up to 100 internal testers, no device registration).

To run the Simulator build: unzip the artifact, boot a simulator and `xcrun simctl install booted Ruled.app && xcrun simctl launch booted app.ruled.notecards`.

**CI secrets for a signed iOS build** (Settings → Secrets and variables → Actions). Without them the iOS job still builds for the Simulator and skips signing.

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of an *Apple Distribution* (or *Apple Development*) certificate exported from Keychain Access as `.p12`: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_PROVISIONING_PROFILE` | base64 of the `.mobileprovision` for `app.ruled.notecards` (App Store, Ad Hoc or Development) |
| `APPLE_DEVELOPMENT_TEAM` | your 10-character Team ID (developer.apple.com → Membership) |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | *optional*, for TestFlight upload: an App Store Connect API key (Users and Access → Integrations → keys, "App Manager" role): its Key ID, the Issuer ID, and the contents of the downloaded `AuthKey_XXXX.p8` |

The export method has to match the profile type: CI uses `app-store-connect` (App Store profile, TestFlight) when the API key secrets are set and `release-testing` (Ad Hoc profile) otherwise. Override it with an Actions **variable** `IOS_EXPORT_METHOD` (`app-store-connect`, `release-testing` or `debugging` for a Development profile). TestFlight uploads only happen from `main` and tags. For TestFlight you also need to create the app once in App Store Connect with bundle ID `app.ruled.notecards`.

On iOS, **Export backup** opens the system "Save to Files" sheet (a copy also stays in **Files → On My iPhone → Ruled**), and **Import & merge** opens the Files picker, so iCloud Drive works as the hand-off between devices.

**Browser:** `npm run build`, then serve `dist/` from any static host, or run `npm run dev`.

## Develop

```bash
npm install
npm test             # scheduler + sync tests
npm run dev          # web, at http://localhost:1420
npx tauri dev        # desktop app
npx tauri android build --apk --target aarch64 && scripts/sign-apk.sh
```

iOS builds need macOS with Xcode, XcodeGen (`brew install xcodegen`) and `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`; run `npx tauri ios init` once, then `npx tauri ios dev` (Simulator) or `npx tauri ios build`. `src-tauri/gen/apple` is generated and not committed: CI regenerates it with the pinned Tauri CLI on every build, so the Xcode project always matches `tauri.conf.json` and the CLI's templates (several CLI releases have fixed bugs that only take effect after regenerating it). iOS-specific settings live in `tauri.conf.json` (`bundle > iOS`), `src-tauri/Info.ios.plist` (merged into the generated Info.plist) and `src-tauri/capabilities/ios.json`. The minimum iOS version is 15.0: WebRTC (P2P sync) needs iOS 14.3+ in WKWebView, and current Xcode/Tauri require 15.0.

Android builds need the Android SDK and NDK 27 (`ANDROID_HOME`, `NDK_HOME`) and the Rust Android targets. Keep the same signing keystore for every release, or Android won't install an update over the old app. For CI, put it in the `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` secrets.

## Layout

```
src/lib/scheduler/   Anki scheduler port (states, fuzz, answering, timing)
src/lib/store.ts     IndexedDB store, HLC-stamped records, tombstones
src/lib/sync/        replication protocol (engine.ts) + WebRTC transport (p2p.ts)
src/lib/ops.ts       notes → cards, answering/undo, study queue, import
src/views/           UI
src-tauri/           Tauri v2 shell (macOS, iOS, Android)
```

## Not included

FSRS (Anki's optional alternative scheduler), the load balancer, filtered decks, sibling burying (off by default in Anki), images/audio, and `.apkg` import.
