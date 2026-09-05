# Checklist Collection

A multi-checklist inspection app — tabs of checklists, five item types (checkbox, text, photo, sign-off, section), drag-to-reorder, light/dark theme, and PDF export. Built as a single web codebase (Vite + vanilla JS) wrapped with [Capacitor](https://capacitorjs.com/) for iOS/Android and [Tauri](https://tauri.app/) for a native desktop app (Linux/macOS/Windows), plus a PWA install as a lighter-weight desktop option.

## Layout

The app window is bookended by two visually distinct strips, in the gray "chrome" tone rather than the checklist's white:

- **Menu bar** (top) — a conventional desktop-style menu bar with dropdowns: **Collection** (export/import the whole collection), **Templates** (template library, save as template, import template), and **Checklist** (add an item, Export PDF, Clear responses), plus the light/dark theme toggle. Only one dropdown is open at a time; click elsewhere or press Escape to close it — picking a one-shot action (Export, Save as template, etc.) closes its menu too, but the Checklist menu's add-item form stays open after each add so you can add several items without reopening it.
- **Footer** (bottom, below the checklist) — the same add-item form and the same Export PDF / Clear responses actions as the Checklist menu, duplicated here so they're reachable from wherever you're scrolled to. Both copies operate on the same active checklist and stay in sync (e.g. picking a response type in one updates the other); "Clear responses" arms/confirms independently per copy. All three footer buttons share the same solid-button shape, colored to tell the kind of action apart at a glance: Add item is Cypress Green, Export PDF and Clear responses are Cypress Blue, and Clear responses switches to Cypress Red once armed (its first click) to flag the pending destructive confirm.

Everything in between — the collection title/description, checklist tabs, and the checklist itself — stays on the white panel background. Each tab gets an accent color, assigned by a deterministic hash of the checklist's id (so a tab keeps its color regardless of tab order or how many others are open) — purely a visual aid for telling tabs apart at a glance, not a status indicator. The palette draws one mid-tone step from each of the brand's Cypress Blue, Red, and Green swatches, picked so every color reads clearly against both the light and dark theme's background — mixing hues, rather than shading a single one, also makes neighboring tabs easier to tell apart than shades of blue alone would.

## Stack

- **UI**: plain HTML/CSS/JS (no framework) — ported from the original Checklist Collection artifact
- **Bundler**: Vite, output to `www/` (Capacitor's `webDir`)
- **PDF export**: [jsPDF](https://github.com/parallax/jsPDF)
- **Native bridge**: Capacitor — `@capacitor/preferences` (state persistence), `@capacitor/filesystem` + `@capacitor/share` (save/share the exported PDF on iOS/Android), `@capacitor/camera` (native camera/photo-library capture on iOS/Android); Tauri — `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs` (native "Save As" dialog for the exported PDF on desktop)

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

## Install as a PWA (one link, any device)

There's no single installer file that works on both PCs and phones — every OS wants its own package format, and Tauri in particular can only build a given OS's installer by running on that OS. The practical equivalent of "one install" is a **Progressive Web App**: a single URL that any browser, on any device, can install like a native app (an icon on the home screen or in the Start Menu/Applications folder), no app store and no separate download.

This repo deploys to that URL via **GitHub Pages**, built by [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) on every push to the tracked branch (currently `claude/checklist-collection-artifact-nurct8` — update the workflow's `branches:` list once this merges to a permanent default branch). It runs `npm run build:pages`, which is the same Vite build as everything else but with `--base=/Checklist-Builder/` so asset URLs resolve under the project-page subpath, output to `dist/` (kept separate from `www/`, which Capacitor's `cap:sync` expects unchanged). The resulting site is served at:

```
https://toddmendenhall.github.io/Checklist-Builder/
```

**One-time setup**: GitHub Pages needs to be enabled with source "GitHub Actions" — go to the repo's Settings → Pages and select that, if the first workflow run doesn't configure it automatically. After that, every push redeploys.

What makes it actually installable, not just a website — `public/manifest.webmanifest` (name, theme color, and icon set generated from the Cypress droplet mark, including a padded "maskable" variant so OS icon masks don't clip it) and `public/sw.js` (a small service worker; `src/main.js` registers it, skipped on Tauri/Capacitor since those already load from a local bundle rather than a real server). The service worker doesn't try to precache an exact file list — Vite's JS/CSS filenames are content-hashed and change every build — instead it caches same-origin requests as they happen and serves from cache first, so a second visit (and basic offline use) doesn't need the network.

To build/preview this variant locally: `npm run build:pages` then `npm run preview:pages`.

## Desktop

For a packaged native desktop binary (as opposed to the PWA install above), the app is wrapped with [Tauri](https://tauri.app/) — a system-webview shell, so the shipped binary is a few MB rather than an Electron-sized Chromium bundle. Native project files live in `src-tauri/`.

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
- **Export…** — saves one template as a small `.json` file (native Save dialog on desktop, share sheet on iOS/Android, browser download on the web) that can be emailed, AirDropped, or otherwise handed to someone else.
- **Export all templates…** — the same idea, bundled: every saved template in one `.json` file (a "pack"), for handing someone your whole set of checklists at once — the more common case in practice.
- **Import template…** — opens a file picker (the same native file-open dialog on every platform, including inside the Tauri desktop window) and adds the imported template(s) to your saved list. It auto-detects whether the file holds one template or a pack of several, so there's a single Import control either way.

There's no server or account involved — sharing a template just means sharing the file. Each format is a small versioned JSON wrapper (`{ type, version, template }` for one, `{ type, version, templates }` for a pack); importing validates the shape and rejects anything else with a plain-language error instead of crashing.

## Sharing a whole collection (with responses)

Templates only ever carry structure. If instead you want to hand someone (or move to another one of your own devices) *everything currently open* — every checklist tab, exactly as filled in: checked boxes, typed answers, attached photos, signatures — use **Export collection…** / **Import collection…**, under the **Collection** menu in the menu bar.

- **Export collection…** saves the whole collection — `collectionTitle`, `collectionDescription`, and every checklist with its items and their current responses — to one `.json` file, through the same native Save dialog / share sheet / browser download used everywhere else.
- **Import collection…** reads a collection file and **replaces everything currently open** — this is a destructive action (there's no undo), so it always confirms first, naming the collection it's about to load in place of your current one.

Because this format includes responses, an exported collection file can contain photos, signatures, and whatever else was typed into it — worth keeping that in mind before emailing one around.

## Photo capture

Tapping "Add photo" on a photo-type item behaves differently by platform: on iOS/Android it calls `@capacitor/camera`'s `Camera.getPhoto()` with `source: CameraSource.Prompt`, which shows the native "Take Photo / Choose from Library" action sheet — the plugin also handles downscaling (`width: 1600`) and EXIF orientation correction itself. On the web and desktop (Tauri included, since it isn't a platform the Capacitor plugin knows about) it falls back to a plain file input, with the same resizing/JPEG re-encoding done manually in `resizePhotoFile()`. Either path lands on the same `item.photo = { dataUrl, width, height }` shape, so the rest of the app (thumbnail display, PDF embedding) doesn't need to know which path was used. Cancelling the native picker is treated as a no-op, not an error.

## Locking a checklist

Once a checklist's structure is finalized (or someone else is out in the field filling it in), "Lock checklist" — in the Checklist menu or the footer — freezes its item list: no adding, removing, or drag-reordering items, on either the header or footer controls, until it's unlocked again. Everything else about *using* the checklist still works while locked — checking boxes, typing responses, attaching photos, drawing signatures, even Clear responses — since the point is to protect the checklist's shape, not stop anyone from filling it in. A locked checklist shows a small lock icon on its tab so it's visible without opening either menu. The lock state is per-checklist (each tab locks independently) and travels with a checklist through collection export/import, but not through templates or PDF export, since those only ever carry structure or a point-in-time snapshot.

## Known follow-ups

- Google Fonts are loaded from a CDN; the type stacks fall back to system fonts if offline, but self-hosting the fonts would make the UI fully offline-consistent.
- The desktop app icon set (`src-tauri/icons/`) is Tauri's default placeholder — swap in real app icons before shipping.
