# Checklist Collection

A multi-checklist inspection app — tabs of checklists, five item types (checkbox, text, photo, sign-off, section), drag-to-reorder, light/dark theme, and PDF export. Built as a single web codebase (Vite + vanilla JS) wrapped with [Capacitor](https://capacitorjs.com/) to ship on iOS, Android, and desktop (via a PWA install or a desktop wrapper like Tauri/Electron).

## Stack

- **UI**: plain HTML/CSS/JS (no framework) — ported from the original Checklist Collection artifact
- **Bundler**: Vite, output to `www/` (Capacitor's `webDir`)
- **PDF export**: [jsPDF](https://github.com/parallax/jsPDF)
- **Native bridge**: Capacitor — `@capacitor/preferences` (state persistence), `@capacitor/filesystem` + `@capacitor/share` (save/share the exported PDF on device)

## Develop in the browser

```bash
npm install
npm run dev       # Vite dev server with hot reload
npm run build     # production build -> www/
npm run preview   # serve the production build
```

All app logic lives in `src/main.js` and `src/style.css`; markup is in `index.html`.

## Run on iOS / Android

Native platform projects are checked in under `ios/` and `android/`. This container can scaffold and sync them, but actually running a simulator/emulator or a full device build requires Xcode (macOS) or Android Studio locally.

```bash
npm run cap:sync      # build the web app and copy it into ios/ and android/
npm run cap:ios        # sync + open the Xcode project (macOS + Xcode required)
npm run cap:android    # sync + open the Android Studio project
```

After pulling changes, or on a new machine, run `npx cap sync` to install/update the native plugin dependencies (CocoaPods on iOS, Gradle on Android).

## Desktop

The same `www/` build is a fully installable PWA out of the box (open it in a browser and "Install app"). For a packaged desktop binary, wrap `www/` with [Tauri](https://tauri.app/) or [Electron](https://www.electronjs.org/) — neither is wired up yet.

## State & data

Checklist data is stored locally on-device via Capacitor Preferences (falls back to `localStorage` in a plain browser). There is no server/sync component — each device's data is independent.

## Known follow-ups

- Google Fonts are loaded from a CDN; the type stacks fall back to system fonts if offline, but self-hosting the fonts would make the UI fully offline-consistent.
- Photo capture currently uses a plain `<input type="file" capture>`; swapping in `@capacitor/camera` would give a more native camera UX.
- No desktop wrapper (Tauri/Electron) is configured yet.
