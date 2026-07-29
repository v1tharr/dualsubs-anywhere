// Build script: assembles dist/dualsubs-anywhere.user.js from the shared
// core + the Tampermonkey storage adapter. No bundler needed — these files
// are plain scripts sharing the global scope, so concatenation is enough.
//
// Usage: npm run build

const fs = require('fs');
const path = require('path');

const HEADER = `// ==UserScript==
// @name         Dual Subs Anywhere
// @namespace    https://github.com/v1tharr/dualsubs-anywhere
// @version      0.2.5
// @description  Overlay two subtitle tracks (e.g. English + Russian) on top of any HTML5 video, on any site
// @author       v1tharr
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js
// @downloadURL  https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js
// ==/UserScript==

`;

const FILES = [
  'src/storage-userscript.js',
  'src/srt-parser.js',
  'src/zip-lite.js',
  'src/core.js'
];

const chunks = FILES.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'));
const output = HEADER + chunks.join('\n\n');

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'dualsubs-anywhere.user.js'), output);

console.log('Built dist/dualsubs-anywhere.user.js');
