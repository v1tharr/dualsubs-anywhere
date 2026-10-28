// ==UserScript==
// @name         Dual Subs Anywhere
// @namespace    https://github.com/v1tharr/dualsubs-anywhere
// @version      0.3.2
// @description  Overlay two subtitle tracks (e.g. English + Russian) on top of any HTML5 video, on any site
// @author       v1tharr
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.opensubtitles.com
// @connect      www.opensubtitles.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js
// @downloadURL  https://raw.githubusercontent.com/v1tharr/dualsubs-anywhere/main/dist/dualsubs-anywhere.user.js
// ==/UserScript==

// Storage adapter for the Tampermonkey/userscript build.
// Provides the same window.DualSubsStorage interface the core module expects.
// This file is concatenated into dist/dualsubs-anywhere.user.js by build.js —
// it is not loaded on its own (GM_* functions only exist in a userscript context).
(function () {
  window.DualSubsStorage = {
    get(key, callback) {
      const value = GM_getValue(key, null);
      callback(value);
    },
    set(key, value) {
      GM_setValue(key, value);
    }
  };
})();


// Pure parsing logic — no DOM access, so it can be unit tested directly
// (works both as a plain script tag in the extension and as a CommonJS
// module under Node/Vitest).

function parseSRT(text) {
  const blocks = text.replace(/^\uFEFF/, '') // strip BOM if present
    .replace(/\r/g, '')
    .trim()
    .split(/\n\n+/);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;

    const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
    const start = toSeconds(startStr);
    const end = toSeconds(endStr);
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    const cueText = textLines.join('\n').replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
    if (!cueText) continue;

    cues.push({ start, end, text: cueText });
  }
  return cues;
}

function toSeconds(t) {
  // supports both "," and "." as the ms separator
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

function findCue(cues, time) {
  for (const c of cues) {
    if (time >= c.start && time <= c.end) return c.text;
  }
  return '';
}

// Old Russian/CIS subtitle files are very often Windows-1251, not UTF-8.
// Try strict UTF-8 first (throws on invalid byte sequences); if that fails,
// fall back to windows-1251, which the browser's TextDecoder supports natively.
function decodeSubtitleBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch (e2) {
      return new TextDecoder('utf-8').decode(bytes); // last resort, lossy
    }
  }
}

if (typeof window !== 'undefined') {
  window.DualSubs = window.DualSubs || {};
  window.DualSubs.parseSRT = parseSRT;
  window.DualSubs.toSeconds = toSeconds;
  window.DualSubs.findCue = findCue;
  window.DualSubs.decodeSubtitleBytes = decodeSubtitleBytes;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSRT, toSeconds, findCue, decodeSubtitleBytes };
}


// Minimal ZIP reader — replaces JSZip entirely.
// Parses the central directory ourselves (simple, well-documented binary format)
// and decompresses entries using the browser's native DecompressionStream,
// instead of relying on a third-party pure-JS inflate implementation.
// Exposed as window.DualSubsZip for use by core.js.

(function () {
  'use strict';

  function listEntries(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    // End Of Central Directory record: scan backwards for its signature.
    // (comment field can be up to 65535 bytes, so search that far from the end)
    let eocd = -1;
    const searchStart = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= searchStart; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Not a valid zip file (end-of-central-directory not found)');

    const entryCount = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < entryCount; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) {
        throw new Error('Corrupt central directory entry at index ' + i);
      }
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = new TextDecoder('utf-8').decode(nameBytes);
      const isDir = name.endsWith('/');

      entries.push({ name, method, compSize, uncompSize, localOffset, isDir });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, bytes, view };
  }

  async function readEntry(zipData, entry) {
    const { bytes, view } = zipData;
    const lp = entry.localOffset;
    if (view.getUint32(lp, true) !== 0x04034b50) {
      throw new Error('Corrupt local file header for "' + entry.name + '"');
    }
    const nameLen = view.getUint16(lp + 26, true);
    const extraLen = view.getUint16(lp + 28, true);
    const dataStart = lp + 30 + nameLen + extraLen;
    const dataBytes = bytes.subarray(dataStart, dataStart + entry.compSize);

    let outBytes;
    if (entry.method === 0) {
      // stored (no compression)
      outBytes = dataBytes;
    } else if (entry.method === 8) {
      // deflate — ZIP uses raw deflate streams (no zlib/gzip wrapper)
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser does not support DecompressionStream (needed to unzip deflate entries)');
      }
      const stream = new Blob([dataBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      outBytes = new Uint8Array(buf);
    } else {
      throw new Error('Unsupported compression method (' + entry.method + ') for "' + entry.name + '"');
    }
    return window.DualSubs.decodeSubtitleBytes(outBytes);
  }

  window.DualSubsZip = { listEntries, readEntry };
})();


// OpenSubtitles REST API v1 client. Uses GM_xmlhttpRequest, not fetch() —
// a page-context fetch gets blocked by CORS on most sites.
(function () {
  'use strict';

  const API_BASE = 'https://api.opensubtitles.com/api/v1';

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res);
          } else {
            reject(new Error('HTTP ' + res.status + ' for ' + details.url));
          }
        },
        onerror: () => reject(new Error('Network error for ' + details.url)),
        ontimeout: () => reject(new Error('Request timed out for ' + details.url))
      });
    });
  }

  // query: free-text title (from document.title, cleaned up by the caller)
  // languages: comma-separated ISO 639-1 codes, e.g. "en" or "ru"
  async function search(apiKey, query, languages) {
    const params = new URLSearchParams({ query, languages });
    const res = await gmRequest({
      method: 'GET',
      url: API_BASE + '/subtitles?' + params.toString(),
      headers: { 'Api-Key': apiKey },
      timeout: 15000
    });
    const data = JSON.parse(res.responseText);
    return (data.data || []).map(item => ({
      fileId: item.attributes?.files?.[0]?.file_id,
      releaseName: item.attributes?.release || item.attributes?.feature_details?.title || 'Untitled',
      language: item.attributes?.language,
      downloadCount: item.attributes?.download_count || 0
    })).filter(r => r.fileId);
  }

  async function requestDownloadLink(apiKey, fileId) {
    const res = await gmRequest({
      method: 'POST',
      url: API_BASE + '/download',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({ file_id: fileId }),
      timeout: 15000
    });
    const data = JSON.parse(res.responseText);
    if (!data.link) throw new Error('No download link in response');
    console.log('[DualSubs] /download response:', data); // check real field names for quota here
    return { link: data.link, remaining: data.remaining, requests: data.requests, resetTime: data.reset_time };
  }

  async function fetchText(url) {
    // arraybuffer, not text — decodeSubtitleBytes handles non-UTF-8 files
    const res = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 20000 });
    if (res.response instanceof ArrayBuffer && window.DualSubs && window.DualSubs.decodeSubtitleBytes) {
      return window.DualSubs.decodeSubtitleBytes(new Uint8Array(res.response));
    }
    return res.responseText;
  }

  window.DualSubsAPI = { search, requestDownloadLink, fetchText };
})();

// Shared core: finds <video> elements, overlays two subtitle tracks with a
// small control panel. Storage-agnostic — relies on window.DualSubsStorage,
// which each adapter (webext / userscript) sets up before this file runs.

(function () {
  'use strict';

  if (window.__dualSubsInitialized) {
    console.log('[DualSubs] already initialized in this frame — skipping duplicate injection.');
    return;
  }
  window.__dualSubsInitialized = true;

  if (!window.DualSubs) {
    console.error('[DualSubs] window.DualSubs is missing — srt-parser.js did not attach correctly. Aborting.');
    return;
  }
  const { parseSRT, findCue } = window.DualSubs;
  console.log('[DualSubs] core.js starting, zip reader available:', typeof window.DualSubsZip !== 'undefined',
    '| DecompressionStream supported:', typeof DecompressionStream !== 'undefined');
  const STORAGE_KEY = 'dualsubs:' + location.hostname + location.pathname + location.search;
  const API_KEY_STORAGE_KEY = 'dualsubs:opensubtitles-api-key';

  // The video is often inside a cross-origin player iframe, whose own title
  // is useless — ask the top frame for its title via postMessage instead.
  if (window.top === window) {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'dualsubs:get-title' && e.source) {
        e.source.postMessage({ type: 'dualsubs:title', title: document.title }, '*');
      }
    });
  }

  function getBestTitle() {
    if (window.top === window) {
      return Promise.resolve(guessTitleFromPage());
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (title) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        resolve(title);
      };
      const onMessage = (e) => {
        if (e.data && e.data.type === 'dualsubs:title') {
          finish(cleanTitle(e.data.title));
        }
      };
      window.addEventListener('message', onMessage);
      window.top.postMessage({ type: 'dualsubs:get-title' }, '*');
      setTimeout(() => finish(guessTitleFromPage()), 500); // no reply — use our own title
    });
  }

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' timed out after ' + (ms / 1000) + 's')), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  let topCues = [], bottomCues = [];
  let topOffset = 0, bottomOffset = 0;
  let topFileName = null, bottomFileName = null;
  let fontSize = 20;
  let subPosition = 75; // % from top of video where the subtitle block sits
  let topBox, bottomBox, wrap, currentVideo;
  let btnEl, panelEl;
  let visible = true;
  let activeSlot = null; // 'top' | 'bottom' — which slot a zip-picker choice applies to
  let refreshStatus = () => {}; // wired up once the panel exists

  function loadSaved(callback) {
    window.DualSubsStorage.get(STORAGE_KEY, (data) => {
      if (data) {
        topCues = data.top || [];
        bottomCues = data.bottom || [];
        topOffset = data.topOffset || 0;
        bottomOffset = data.bottomOffset || 0;
        topFileName = data.topFileName || null;
        bottomFileName = data.bottomFileName || null;
        fontSize = data.fontSize || 20;
        subPosition = data.subPosition || 75;
        visible = data.visible !== false;
      }
      callback();
    });
  }

  function save() {
    window.DualSubsStorage.set(STORAGE_KEY, {
      top: topCues, bottom: bottomCues,
      topOffset, bottomOffset,
      topFileName, bottomFileName,
      fontSize, subPosition, visible
    });
  }

  function setVisible(v) {
    visible = v;
    if (wrap) wrap.style.display = visible ? 'flex' : 'none';
    save();
  }

  // ---------- file loading (.srt or .zip) ----------
  function showToast(message, isError) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; background: ${isError ? '#8b1e1e' : '#1e6b3a'};
      color: #fff; padding: 8px 16px; border-radius: 6px;
      font: 13px Arial, sans-serif; max-width: 80vw; text-align: center;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function pickFile(slot) {
    activeSlot = slot;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.zip';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.zip')) {
        handleZip(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => applyCues(activeSlot, reader.result, file.name);
        reader.onerror = () => showToast('Failed to read file: ' + file.name, true);
        reader.readAsText(file, 'utf-8');
      }
    };
    input.click();
  }

  function applyCues(slot, text, fileName) {
    const cues = parseSRT(text);
    if (cues.length === 0) {
      showToast('No subtitle lines found in "' + fileName + '" — is this the right file?', true);
      return;
    }
    if (slot === 'top') { topCues = cues; topFileName = fileName; }
    else { bottomCues = cues; bottomFileName = fileName; }
    save();
    refreshStatus();
    showToast((slot === 'top' ? 'Top' : 'Bottom') + ' subtitles loaded: ' + fileName, false);
  }

  function handleZip(file) {
    console.log('[DualSubs] zip selected:', file.name, file.size, 'bytes');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        console.log('[DualSubs] file read into memory, parsing zip directory...');
        const zipData = window.DualSubsZip.listEntries(reader.result);
        console.log('[DualSubs] zip parsed, entry count:', zipData.entries.length);
        const entries = zipData.entries.filter(
          e => !e.isDir && e.name.toLowerCase().endsWith('.srt')
        );
        console.log('[DualSubs] .srt entries found:', entries.map(e => e.name));
        showZipPicker(zipData, entries);
      } catch (err) {
        console.error('[DualSubs] zip parse error', err);
        showZipPicker(null, [], 'Failed to open zip: ' + err.message);
      }
    };
    reader.onerror = () => showZipPicker(null, [], 'Failed to read the zip file from disk.');
    reader.readAsArrayBuffer(file);
  }

  function showZipPicker(zipData, entries, errorMsg) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.7); display: flex;
      align-items: center; justify-content: center;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background: #1a1a1a; color: #fff; padding: 16px; border-radius: 8px;
      max-height: 70vh; overflow-y: auto; width: 420px; font: 13px Arial, sans-serif;
    `;
    const title = document.createElement('div');
    title.textContent = `Pick a subtitle file for the ${activeSlot.toUpperCase()} track:`;
    title.style.cssText = 'margin-bottom: 10px; font-weight: bold;';
    box.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'margin-bottom: 10px; font-size: 12px; min-height: 16px;';
    box.appendChild(status);

    if (errorMsg) {
      status.textContent = errorMsg;
      status.style.color = '#ff6b6b';
    } else if (entries.length === 0) {
      status.textContent = 'No .srt files found inside this zip.';
      status.style.color = '#ff6b6b';
    }

    entries.forEach(entry => {
      const row = document.createElement('div');
      row.textContent = entry.name;
      row.style.cssText = 'cursor:pointer; padding:6px 8px; border-radius:4px; word-break:break-all;';
      row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,0.15)');
      row.onmouseleave = () => (row.style.background = 'transparent');
      row.onclick = async () => {
        status.style.color = '#ccc';
        status.textContent = 'Loading...';
        console.log('[DualSubs] reading entry:', entry.name, 'method:', entry.method, 'compressed size:', entry.compSize);
        try {
          const text = await withTimeout(window.DualSubsZip.readEntry(zipData, entry), 15000, 'Reading file');
          console.log('[DualSubs] entry read OK, text length:', text.length);
          const cues = parseSRT(text);
          console.log('[DualSubs] parsed cues:', cues.length);
          if (cues.length === 0) {
            status.textContent = 'No subtitle lines found in this file — pick another one.';
            status.style.color = '#ff6b6b';
            return;
          }
          applyCues(activeSlot, text, entry.name);
          overlay.remove();
        } catch (err) {
          console.error('[DualSubs] entry read error', err);
          status.textContent = 'Failed to read this file: ' + err.message;
          status.style.color = '#ff6b6b';
        }
      };
      box.appendChild(row);
    });

    const cancel = document.createElement('div');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'cursor:pointer; margin-top:10px; text-align:center; opacity:0.7;';
    cancel.onclick = () => overlay.remove();
    box.appendChild(cancel);

    overlay.appendChild(box);
    (getFullscreenElement() || document.body).appendChild(overlay);

    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('dblclick', e => e.stopPropagation());
    overlay.addEventListener('mousedown', e => e.stopPropagation());
  }

  // ---------- OpenSubtitles auto-search ----------
  // Only present when window.DualSubsAPI exists (opensubtitles-api.js was
  // included in this build) — on the main/userscript MVP build it's absent
  // and these panel rows are simply not added (see buildPanel below).

  function cleanTitle(rawTitle) {
    // strip trailing " - SiteName" / " | SiteName" junk
    const t = (rawTitle || '')
      .replace(/\s*[|\-–—]\s*[^|\-–—]{1,40}$/, '')
      .trim();
    return t || rawTitle || '';
  }

  function guessTitleFromPage() {
    return cleanTitle(document.title);
  }

  function getApiKey(callback) {
    window.DualSubsStorage.get(API_KEY_STORAGE_KEY, (key) => {
      if (key) { callback(key); return; }
      const entered = window.prompt(
        'Enter your free OpenSubtitles API key (opensubtitles.com → Consumers → API):'
      );
      if (!entered) { callback(null); return; }
      window.DualSubsStorage.set(API_KEY_STORAGE_KEY, entered);
      callback(entered);
    });
  }

  const COMMON_LANGUAGES = [
    ['en', 'English'], ['ru', 'Russian'], ['es', 'Spanish'], ['pt-br', 'Portuguese (BR)'],
    ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
    ['pl', 'Polish'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
    ['zh-cn', 'Chinese (Simplified)'], ['ja', 'Japanese'], ['ko', 'Korean']
  ];

  async function autoFindSubtitles(slot) {
    if (!window.DualSubsAPI) {
      showToast('Auto-find is not available in this build.', true);
      return;
    }
    getApiKey(async (apiKey) => {
      if (!apiKey) return;
      const guessed = await getBestTitle(); // just a starting point, user can edit it in the modal
      showSearchSetupModal(slot, guessed, (query, lang) => {
        showToast('Searching OpenSubtitles for "' + query + '" (' + lang + ')...', false);
        window.DualSubsAPI.search(apiKey, query, lang)
          .then(results => {
            if (results.length === 0) {
              showToast('No results found for "' + query + '". Try loading a file manually.', true);
              return;
            }
            showSearchResultsPicker(slot, apiKey, results);
          })
          .catch(err => {
            console.error('[DualSubs] OpenSubtitles search failed', err);
            showToast('Search failed: ' + err.message, true);
          });
      });
    });
  }

  function showSearchSetupModal(slot, guessedTitle, onSearch) {
    const defaultLang = slot === 'top' ? 'en' : 'ru';
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.7); display: flex;
      align-items: center; justify-content: center;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background: #1a1a1a; color: #fff; padding: 16px; border-radius: 8px;
      width: 320px; font: 13px Arial, sans-serif; display: flex; flex-direction: column; gap: 10px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Auto-find ' + slot.toUpperCase() + ' track';
    title.style.fontWeight = 'bold';
    box.appendChild(title);

    const queryInput = document.createElement('input');
    queryInput.type = 'text';
    queryInput.value = guessedTitle;
    queryInput.placeholder = 'Movie / episode title';
    queryInput.style.cssText = 'padding:6px; border-radius:4px; border:1px solid #444; background:#111; color:#fff;';
    box.appendChild(queryInput);

    const langSelect = document.createElement('select');
    langSelect.style.cssText = 'padding:6px; border-radius:4px; border:1px solid #444; background:#111; color:#fff;';
    COMMON_LANGUAGES.forEach(([code, name]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name + ' (' + code + ')';
      if (code === defaultLang) opt.selected = true;
      langSelect.appendChild(opt);
    });
    const otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = 'Other...';
    langSelect.appendChild(otherOpt);
    box.appendChild(langSelect);

    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.placeholder = 'ISO 639-1 code, e.g. sv';
    otherInput.style.cssText = 'padding:6px; border-radius:4px; border:1px solid #444; background:#111; color:#fff; display:none;';
    box.appendChild(otherInput);
    langSelect.onchange = () => {
      otherInput.style.display = langSelect.value === '__other__' ? 'block' : 'none';
    };

    const helpLink = document.createElement('a');
    helpLink.href = 'https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes';
    helpLink.target = '_blank';
    helpLink.rel = 'noopener noreferrer';
    helpLink.textContent = 'Full language code list';
    helpLink.style.cssText = 'color:#7CFC7C; font-size:11px;';
    box.appendChild(helpLink);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
    const cancelBtn = document.createElement('span');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'cursor:pointer; padding:6px 10px; opacity:0.7;';
    cancelBtn.onclick = () => overlay.remove();
    const searchBtn = document.createElement('span');
    searchBtn.textContent = 'Search';
    searchBtn.style.cssText = 'cursor:pointer; padding:6px 10px; background:rgba(0,150,80,0.85); border-radius:4px;';
    searchBtn.onclick = () => {
      const query = queryInput.value.trim();
      if (!query) return;
      const lang = (langSelect.value === '__other__' ? otherInput.value : langSelect.value).trim().toLowerCase();
      if (!lang) return;
      overlay.remove();
      onSearch(query, lang);
    };
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(searchBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    (getFullscreenElement() || document.body).appendChild(overlay);
    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('dblclick', e => e.stopPropagation());
    overlay.addEventListener('mousedown', e => e.stopPropagation());
    queryInput.focus();
  }

  function showSearchResultsPicker(slot, apiKey, results) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.7); display: flex;
      align-items: center; justify-content: center;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background: #1a1a1a; color: #fff; padding: 16px; border-radius: 8px;
      max-height: 70vh; overflow-y: auto; width: 420px; font: 13px Arial, sans-serif;
    `;
    const title = document.createElement('div');
    title.textContent = `Pick a result for the ${slot.toUpperCase()} track:`;
    title.style.cssText = 'margin-bottom: 10px; font-weight: bold;';
    box.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'margin-bottom: 10px; font-size: 12px; min-height: 16px; color: #ccc;';
    box.appendChild(status);

    results.forEach(r => {
      const row = document.createElement('div');
      row.textContent = `[${r.language}] ${r.releaseName} (${r.downloadCount} downloads)`;
      row.style.cssText = 'cursor:pointer; padding:6px 8px; border-radius:4px; word-break:break-all;';
      row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,0.15)');
      row.onmouseleave = () => (row.style.background = 'transparent');
      row.onclick = async () => {
        status.textContent = 'Downloading...';
        try {
          const { link, remaining, requests } = await window.DualSubsAPI.requestDownloadLink(apiKey, r.fileId);
          const text = await window.DualSubsAPI.fetchText(link);
          const cues = parseSRT(text);
          if (cues.length === 0) {
            status.textContent = 'This result had no readable subtitle lines — pick another.';
            status.style.color = '#ff6b6b';
            return;
          }
          applyCues(slot, text, r.releaseName + '.srt');
          overlay.remove();
          if (typeof remaining === 'number') {
            showToast('OpenSubtitles downloads left today: ' + remaining + (typeof requests === 'number' ? ' / ' + requests : ''), false);
          }
        } catch (err) {
          console.error('[DualSubs] OpenSubtitles download failed', err);
          status.textContent = 'Failed: ' + err.message;
          status.style.color = '#ff6b6b';
        }
      };
      box.appendChild(row);
    });

    const cancel = document.createElement('div');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'cursor:pointer; margin-top:10px; text-align:center; opacity:0.7;';
    cancel.onclick = () => overlay.remove();
    box.appendChild(cancel);

    overlay.appendChild(box);
    (getFullscreenElement() || document.body).appendChild(overlay);

    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('dblclick', e => e.stopPropagation());
    overlay.addEventListener('mousedown', e => e.stopPropagation());
  }

  // ---------- panel UI ----------
  function buildPanel() {
    const btn = document.createElement('div');
    btnEl = btn;
    btn.textContent = 'CC';
    btn.title = 'Dual Subtitles (Alt+S to toggle)';
    const btnBaseStyle = `
      position: fixed; z-index: 2147483647;
      font: bold 12px Arial, sans-serif; padding: 4px 8px; border-radius: 4px;
      cursor: pointer; user-select: none; pointer-events: auto;
    `;
    const paintBtn = () => {
      btn.style.cssText = btnBaseStyle + (visible
        ? 'background: rgba(0,150,80,0.85); color: #fff;'
        : 'background: rgba(0,0,0,0.6); color: #aaa;');
    };

    const panel = document.createElement('div');
    panelEl = panel;
    panel.style.cssText = `
      position: fixed; z-index: 2147483647;
      background: rgba(20,20,20,0.95); color: #fff; font: 13px Arial, sans-serif;
      padding: 8px; border-radius: 6px; display: none; flex-direction: column;
      gap: 6px; min-width: 220px; overflow-y: auto;
      pointer-events: auto;
    `;

    const mkRow = (label, onClick) => {
      const row = document.createElement('div');
      row.textContent = label;
      row.style.cssText = 'cursor:pointer; padding:4px 6px; border-radius:4px;';
      row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,0.15)');
      row.onmouseleave = () => (row.style.background = 'transparent');
      row.onclick = onClick;
      return row;
    };

    const topStatus = document.createElement('div');
    const bottomStatus = document.createElement('div');
    for (const el of [topStatus, bottomStatus]) {
      el.style.cssText = 'padding:2px 6px; font-size:11px; opacity:0.8; word-break:break-all;';
    }

    panel.appendChild(mkRow('Load TOP subtitles (.srt/.zip)', () => pickFile('top')));
    panel.appendChild(topStatus);
    if (window.DualSubsAPI) {
      panel.appendChild(mkRow('🔍 Auto-find TOP (OpenSubtitles)', () => autoFindSubtitles('top')));
    }
    panel.appendChild(mkRow('Load BOTTOM subtitles (.srt/.zip)', () => pickFile('bottom')));
    panel.appendChild(bottomStatus);
    if (window.DualSubsAPI) {
      panel.appendChild(mkRow('🔍 Auto-find BOTTOM (OpenSubtitles)', () => autoFindSubtitles('bottom')));
    }

    refreshStatus = () => {
      topStatus.textContent = topFileName ? ('✓ ' + topFileName) : '— not loaded';
      bottomStatus.textContent = bottomFileName ? ('✓ ' + bottomFileName) : '— not loaded';
      topStatus.style.color = topFileName ? '#7CFC7C' : '#999';
      bottomStatus.style.color = bottomFileName ? '#7CFC7C' : '#999';
    };
    refreshStatus();

    // offset controls
    const offsetRow = (label, get, set) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 6px;';
      const minus = document.createElement('span');
      minus.textContent = '−0.5s';
      minus.style.cssText = 'cursor:pointer; padding:2px 6px; background:rgba(255,255,255,0.1); border-radius:3px;';
      const plus = document.createElement('span');
      plus.textContent = '+0.5s';
      plus.style.cssText = minus.style.cssText;
      const val = document.createElement('span');
      const refresh = () => { val.textContent = label + ': ' + get().toFixed(1) + 's'; };
      minus.onclick = () => { set(get() - 0.5); refresh(); save(); };
      plus.onclick = () => { set(get() + 0.5); refresh(); save(); };
      refresh();
      row.appendChild(val); row.appendChild(minus); row.appendChild(plus);
      return row;
    };

    panel.appendChild(offsetRow('Top offset', () => topOffset, v => (topOffset = v)));
    panel.appendChild(offsetRow('Bottom offset', () => bottomOffset, v => (bottomOffset = v)));

    // font size control (shared by both tracks)
    const fontRow = document.createElement('div');
    fontRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 6px;';
    const fMinus = document.createElement('span');
    fMinus.textContent = 'A−';
    fMinus.style.cssText = 'cursor:pointer; padding:2px 6px; background:rgba(255,255,255,0.1); border-radius:3px;';
    const fPlus = document.createElement('span');
    fPlus.textContent = 'A+';
    fPlus.style.cssText = fMinus.style.cssText;
    const fVal = document.createElement('span');
    const refreshFont = () => {
      fVal.textContent = 'Size: ' + fontSize + 'px';
      if (topBox) topBox.style.fontSize = fontSize + 'px';
      if (bottomBox) bottomBox.style.fontSize = fontSize + 'px';
    };
    fMinus.onclick = () => { fontSize = Math.max(10, fontSize - 2); refreshFont(); save(); };
    fPlus.onclick = () => { fontSize = Math.min(48, fontSize + 2); refreshFont(); save(); };
    refreshFont();
    fontRow.appendChild(fVal); fontRow.appendChild(fMinus); fontRow.appendChild(fPlus);
    panel.appendChild(fontRow);

    // vertical position control
    const posRow = document.createElement('div');
    posRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 6px;';
    const pUp = document.createElement('span');
    pUp.textContent = '▲';
    pUp.style.cssText = 'cursor:pointer; padding:2px 6px; background:rgba(255,255,255,0.1); border-radius:3px;';
    const pDown = document.createElement('span');
    pDown.textContent = '▼';
    pDown.style.cssText = pUp.style.cssText;
    const pVal = document.createElement('span');
    const refreshPos = () => { pVal.textContent = 'Position: ' + subPosition + '%'; };
    pUp.onclick = () => { subPosition = Math.max(5, subPosition - 5); refreshPos(); save(); positionElements(); };
    pDown.onclick = () => { subPosition = Math.min(95, subPosition + 5); refreshPos(); save(); positionElements(); };
    refreshPos();
    posRow.appendChild(pVal); posRow.appendChild(pUp); posRow.appendChild(pDown);
    panel.appendChild(posRow);

    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 6px; cursor:pointer;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = visible;
    checkbox.onchange = () => { setVisible(checkbox.checked); paintBtn(); };
    toggleRow.appendChild(checkbox);
    toggleRow.appendChild(document.createTextNode('Show subtitles'));
    panel.appendChild(toggleRow);

    panel.appendChild(mkRow('Clear subtitles', () => {
      topCues = []; bottomCues = []; topOffset = 0; bottomOffset = 0;
      topFileName = null; bottomFileName = null;
      save(); refreshStatus();
    }));

    btn.onclick = () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      positionElements();
    };
    paintBtn();

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // stop clicks on our UI from bubbling to the video player underneath —
    // otherwise a fast double-click on a button (e.g. position ▲▼) reaches
    // the player and triggers its native double-click-to-exit-fullscreen behavior
    [btn, panel].forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
      el.addEventListener('dblclick', e => e.stopPropagation());
      el.addEventListener('mousedown', e => e.stopPropagation());
    });

    document.addEventListener('keydown', e => {
      if (e.altKey && e.key.toLowerCase() === 's') {
        checkbox.checked = !checkbox.checked;
        setVisible(checkbox.checked);
        paintBtn();
      }
    });
  }

  // ---------- positioning (fixed, computed from the video's on-screen rect) ----------
  function positionElements() {
    if (!currentVideo || !wrap) return;
    const r = currentVideo.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return; // video hidden/not laid out yet

    wrap.style.left = r.left + 'px';
    wrap.style.width = r.width + 'px';
    wrap.style.top = (r.top + r.height * (subPosition / 100)) + 'px';

    if (btnEl) {
      btnEl.style.left = (r.left + 8) + 'px';
      btnEl.style.top = (r.top + r.height * 0.55) + 'px';
    }
    if (panelEl) {
      const panelTop = r.top + r.height * 0.55 + 26;
      panelEl.style.left = (r.left + 8) + 'px';
      panelEl.style.top = panelTop + 'px';
      panelEl.style.maxHeight = Math.max(120, Math.min(window.innerHeight - panelTop - 10, window.innerHeight * 0.7)) + 'px';
    }
  }

  // ---------- fullscreen handling ----------
  // The Fullscreen API only renders the fullscreened element's subtree —
  // anything appended elsewhere (like document.body) becomes invisible.
  // Reparent our elements into whatever is currently fullscreened.
  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
      document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function reparentForFullscreen() {
    const target = getFullscreenElement() || document.body;
    [wrap, btnEl, panelEl].forEach(el => {
      if (el && el.parentElement !== target) target.appendChild(el);
    });
    positionElements();
  }

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
    .forEach(evt => document.addEventListener(evt, reparentForFullscreen));

  // ---------- video overlay ----------
  function ensureOverlay(video) {
    if (currentVideo === video && wrap && document.body.contains(wrap)) return;

    // the video element changed (source swap) — clean up the previous overlay first
    if (currentVideo && currentVideo !== video) {
      currentVideo.removeEventListener('timeupdate', updateSubs);
    }
    if (wrap) wrap.remove();
    if (btnEl) btnEl.remove();
    if (panelEl) panelEl.remove();

    currentVideo = video;

    wrap = document.createElement('div');
    wrap.style.cssText = `
      position: fixed; pointer-events: none; z-index: 2147483647;
      display: ${visible ? 'flex' : 'none'}; flex-direction: column; align-items: center;
      font-family: Arial, sans-serif;
    `;

    topBox = document.createElement('div');
    bottomBox = document.createElement('div');
    for (const box of [topBox, bottomBox]) {
      box.style.cssText = `
        color: #fff; background: rgba(0,0,0,0.6);
        padding: 2px 10px; margin: 2px 0; border-radius: 4px;
        font-size: ${fontSize}px; text-align: center; max-width: 90%;
        text-shadow: 1px 1px 2px #000; white-space: pre-line;
      `;
    }

    wrap.appendChild(topBox);
    wrap.appendChild(bottomBox);
    document.body.appendChild(wrap);
    buildPanel();
    reparentForFullscreen(); // in case we attach while already in fullscreen

    video.addEventListener('timeupdate', updateSubs);
    positionElements();

    if (!window.__dualSubsGlobalListenersAttached) {
      window.__dualSubsGlobalListenersAttached = true;
      window.addEventListener('resize', positionElements);
      window.addEventListener('scroll', positionElements, true); // capture: catches scroll on any ancestor container
      setInterval(positionElements, 500); // fallback for layout changes that don't fire resize/scroll
    }
  }

  function updateSubs() {
    if (!currentVideo) return;
    const t = currentVideo.currentTime;
    topBox.textContent = findCue(topCues, t + topOffset);
    bottomBox.textContent = findCue(bottomCues, t + bottomOffset);
  }

  // Ignore tiny/offscreen <video> elements — hover-preview thumbnails on
  // YouTube/ grids, autoplay teasers, etc. Only the single
  // largest on-screen video on the page is treated as "the player".
  const MIN_VIDEO_WIDTH = 400;
  const MIN_VIDEO_HEIGHT = 220; // comfortably above hover-preview thumbnail sizes on YT

  function isActuallyVisible(el) {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) > 0;
  }

  function pickMainVideo() {
    let best = null, bestArea = 0;
    document.querySelectorAll('video').forEach(v => {
      const r = v.getBoundingClientRect();
      if (r.width < MIN_VIDEO_WIDTH || r.height < MIN_VIDEO_HEIGHT) return; // too small to be the real player
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return; // offscreen
      if (!isActuallyVisible(v)) return; // e.g. a hidden <video> some sites keep in the DOM
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = v; }
    });
    return best;
  }

  function scan() {
    const video = pickMainVideo();
    if (!video) return; // nothing qualifies yet (page still loading, or only thumbnails present)
    if (video.readyState >= 1 || video.src || video.currentSrc) {
      ensureOverlay(video);
    }
  }

  loadSaved(() => {
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 2000);
  });
})();