# Ruled

Local-first spaced-repetition notecards for macOS and Android (and any browser). Ruled schedules cards with **Anki's own algorithm** and syncs **device to device, with no server to run**.

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

**Browser:** `npm run build`, then serve `dist/` from any static host, or run `npm run dev`.

## Develop

```bash
npm install
npm test             # scheduler + sync tests
npm run dev          # web, at http://localhost:1420
npx tauri dev        # desktop app
npx tauri android build --apk --target aarch64 && scripts/sign-apk.sh
```

Android builds need the Android SDK and NDK 27 (`ANDROID_HOME`, `NDK_HOME`) and the Rust Android targets. Keep the same signing keystore for every release, or Android won't install an update over the old app. For CI, put it in the `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` secrets.

## Layout

```
src/lib/scheduler/   Anki scheduler port (states, fuzz, answering, timing)
src/lib/store.ts     IndexedDB store, HLC-stamped records, tombstones
src/lib/sync/        replication protocol (engine.ts) + WebRTC transport (p2p.ts)
src/lib/ops.ts       notes → cards, answering/undo, study queue, import
src/views/           UI
src-tauri/           Tauri v2 shell (macOS + Android)
```

## Not included

FSRS (Anki's optional alternative scheduler), the load balancer, filtered decks, sibling burying (off by default in Anki), images/audio, and `.apkg` import.
