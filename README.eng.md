# Dual Subs Anywhere

[RUS](README.md) | **ENG**

[![CI](https://github.com/v1tharr/dualsubs-anywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/v1tharr/dualsubs-anywhere/actions/workflows/ci.yml)

Overlay two subtitle tracks (e.g. English + Russian) on top of any HTML5 video, on any site — no downloading the video, no re-uploading subtitles every time.

Status: v0.2, actively used and iterated on.

Ships as a single Tampermonkey/Violentmonkey userscript, built from a small set of source files (`src/`) so the logic stays testable and organized rather than living in one giant file. No third-party runtime dependencies — zip files are parsed and decompressed with a small built-in reader on top of the browser's native `DecompressionStream`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey/Greasemonkey — works in any browser with a userscript manager: Chrome, Firefox, Edge)
2. Open **[this link](https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js)** — Tampermonkey will offer to install it
3. Reload the page you want to watch, open any `<video>`, click the **CC** button (left side of the player, mid-height) to load subtitles

Updates are automatic — the script checks the same link for a newer `@version` and Tampermonkey prompts to update.

## Features

- Two independent subtitle tracks (top/bottom), each with its own `.srt`/`.zip` loader and status indicator
- Per-track timing offset (±0.5s buttons) — nudge into sync without knowing the exact release
- Adjustable font size and vertical position, saved per page
- Show/hide toggle (`Alt+S` or the CC button)
- Works in fullscreen — the panel follows the video into and out of fullscreen mode
- Settings persist per page (URL + query), so switching episodes doesn't carry over the wrong subtitles

## Using subtitles from a .zip

Subtitle sites often bundle many release variants (DVDRip/BluRay/HDTV/...) with different timing in one archive. Click **Load TOP/BOTTOM subtitles**, pick the `.zip` directly — a picker lists every `.srt` inside so you can choose without unzipping by hand.

If the exact release isn't obvious (no labels visible in the player), pick any candidate and use the **offset** buttons in the panel to nudge it into sync while watching.

## Dev

```
npm install
npm test      # unit tests for the SRT parser
npm run build # produces dist/dualsubs-anywhere.user.js
```
