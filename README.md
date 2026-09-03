# Checklist Collection

A multi-checklist inspection app — tabs of checklists, five item types (checkbox, text, photo, sign-off, section), drag-to-reorder, light/dark theme, and PDF export. Built as a single web codebase (Vite + vanilla JS) wrapped with [Capacitor](https://capacitorjs.com/) for iOS/Android and [Tauri](https://tauri.app/) for a native desktop app (Linux/macOS/Windows), plus a PWA install as a lighter-weight desktop option.

## Stack

- **UI**: plain HTML/CSS/JS (no framework) — ported from the original Checklist Collection artifact
- **Bundler**: Vite, output to `www/` (Capacitor's `webDir`)
- **PDF export**: [jsPDF](https://github.com/parallax/jsPDF)
- **Native bridge**: Capacitor — `@capacitor/preferences` (state persistence), `@capacitor/filesystem` + `@capacitor/share` (save/share the exported PDF on iOS/Android); Tauri — `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs` (native "Save As" dialog for the exported PDF on desktop)

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

The same `www/` build is a fully installable PWA out of the box (open it in a browser and "Install app"). For a packaged native desktop binary, the app is wrapped with [Tauri](https://tauri.app/) — a system-webview shell, so the shipped binary is a few MB rather than an Electron-sized Chromium bundle. Native project files live in `src-tauri/`.

```bash
npm run desktop:dev     # run the desktop app with hot reload
npm run desktop:build   # produce release binaries/installers for the current OS
```

`desktop:build` output lands in `src-tauri/target/release/bundle/` — a `.deb`/`.rpm`/`.AppImage` on Linux, `.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, each built by running the command on that OS (Tauri cross-compiles poorly; build on/for each target platform, e.g. in CI with a matrix build). First-time setup needs the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed (Rust toolchain, plus WebView2 on Windows, Xcode command line tools on macOS, or `libwebkit2gtk-4.1-dev` + `libgtk-3-dev` on Linux).

`src/main.js` detects Tauri via `isTauri()` from `@tauri-apps/api/core`. State persistence still runs through Capacitor's `Preferences` (its web implementation is just `localStorage`, which works fine in Tauri's webview too — no Tauri-specific storage needed). PDF export is Tauri-specific: clicking "Export PDF" opens the OS's native Save dialog (`@tauri-apps/plugin-dialog`'s `save()`) and writes the PDF straight to the chosen path (`@tauri-apps/plugin-fs`'s `writeFile()`), instead of the browser-download fallback used on the web and the share-sheet flow used on iOS/Android.

## State & data

Checklist data is stored locally on-device via Capacitor Preferences (falls back to `localStorage` in a plain browser). There is no server/sync component — each device's data is independent.

## Templates — reusable, shareable checklists

A **template** is a checklist's structure (title + item labels/types) with no filled-in responses — separate from the checklists in your tabs, which are always filled-in instances. This is what makes a blank checklist reusable:

- **Save as template** — snapshots the current checklist's structure (stripping any responses) into your saved template list.
- **Template library** — a modal listing every saved template as a card (title, description, item count) with actions per template: **New checklist** (opens a brand-new, blank checklist from it — the template itself is untouched, so it can be reused indefinitely), **Export…**, **Rename**, **Add/Edit description**, and **Delete** (click-twice-to-confirm, same pattern as removing a checklist tab).
- **Export…** — saves the template as a small `.json` file (native Save dialog on desktop, share sheet on iOS/Android, browser download on the web) that can be emailed, AirDropped, or otherwise handed to someone else.
- **Import template…** — opens a file picker (the same native file-open dialog on every platform, including inside the Tauri desktop window) to add someone else's exported `.json` template to your own saved template list.

There's no server or account involved — sharing a template just means sharing the file. The template file format is a small versioned JSON wrapper (`{ type, version, template }`); importing validates that shape and rejects anything else with a plain-language error instead of crashing.

## Known follow-ups

- Google Fonts are loaded from a CDN; the type stacks fall back to system fonts if offline, but self-hosting the fonts would make the UI fully offline-consistent.
- Photo capture currently uses a plain `<input type="file" capture>`; swapping in `@capacitor/camera` would give a more native camera UX on mobile.
- The desktop app icon set (`src-tauri/icons/`) is Tauri's default placeholder — swap in real app icons before shipping.
