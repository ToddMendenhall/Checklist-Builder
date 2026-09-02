# Checklist Collection

A multi-checklist inspection app — tabs of checklists, five item types (checkbox, text, photo, sign-off, section), drag-to-reorder, light/dark theme, and PDF export. Built as a single web codebase (Vite + vanilla JS) wrapped with [Capacitor](https://capacitorjs.com/) for iOS/Android and [Tauri](https://tauri.app/) for a native desktop app (Linux/macOS/Windows), plus a PWA install as a lighter-weight desktop option.

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

The same `www/` build is a fully installable PWA out of the box (open it in a browser and "Install app"). For a packaged native desktop binary, the app is wrapped with [Tauri](https://tauri.app/) — a system-webview shell, so the shipped binary is a few MB rather than an Electron-sized Chromium bundle. Native project files live in `src-tauri/`.

```bash
npm run desktop:dev     # run the desktop app with hot reload
npm run desktop:build   # produce release binaries/installers for the current OS
```

`desktop:build` output lands in `src-tauri/target/release/bundle/` — a `.deb`/`.rpm`/`.AppImage` on Linux, `.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, each built by running the command on that OS (Tauri cross-compiles poorly; build on/for each target platform, e.g. in CI with a matrix build). First-time setup needs the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed (Rust toolchain, plus WebView2 on Windows, Xcode command line tools on macOS, or `libwebkit2gtk-4.1-dev` + `libgtk-3-dev` on Linux).

The desktop build runs the same `src/main.js` as the web/mobile builds unmodified: Tauri isn't a platform Capacitor's plugins know about, so `Capacitor.isNativePlatform()` is `false` inside it and the app transparently uses the same `localStorage`-backed `Preferences` and browser-download PDF export it uses on the web. A follow-up could wire the Tauri `fs`/`dialog` plugins for a native "Save As" dialog instead of relying on the browser download.

## State & data

Checklist data is stored locally on-device via Capacitor Preferences (falls back to `localStorage` in a plain browser). There is no server/sync component — each device's data is independent.

## Known follow-ups

- Google Fonts are loaded from a CDN; the type stacks fall back to system fonts if offline, but self-hosting the fonts would make the UI fully offline-consistent.
- Photo capture currently uses a plain `<input type="file" capture>`; swapping in `@capacitor/camera` would give a more native camera UX on mobile.
- The desktop app icon set (`src-tauri/icons/`) is Tauri's default placeholder — swap in real app icons before shipping.
- PDF export on desktop uses a browser-style download rather than a native "Save As" dialog (see the Desktop section above).
