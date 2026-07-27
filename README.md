# Dual Subtitles Anywhere

Overlay two subtitle tracks (e.g. English + Russian) on top of any HTML5 video, on any site — no downloading the video, no re-uploading subtitles every time.

Status: early WIP (v0.1, MVP).

Ships as a single Tampermonkey/Violentmonkey userscript, built from a small set of source files (`src/`) so the logic stays testable and organized rather than living in one giant file.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey/Greasemonkey — works in any browser with a userscript manager: Chrome, Firefox, Edge)
2. Open **[this link](https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js)** — Tampermonkey will offer to install it
3. Reload the page you want to watch, open any `<video>`, click the **CC** button (left side of the player, mid-height) to load subtitles

Updates are automatic — the script checks the same link for a newer `@version` and Tampermonkey prompts to update.

## Using subtitles from a .zip

Subtitle sites often bundle many release variants (DVDRip/BluRay/HDTV/...) with different timing in one archive. Click **Load TOP/BOTTOM subtitles**, pick the `.zip` directly — a picker lists every `.srt` inside so you can choose without unzipping by hand.

If the exact release isn't obvious (no labels visible in the player), pick any candidate and use the **offset** buttons (±0.5s) in the panel to nudge it into sync while watching.

## Dev

```
npm install
npm test      # unit tests for the SRT parser
npm run build # produces dist/dualsubs-anywhere.user.js
```
