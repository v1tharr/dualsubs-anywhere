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
    panel.appendChild(mkRow('Load BOTTOM subtitles (.srt/.zip)', () => pickFile('bottom')));
    panel.appendChild(bottomStatus);

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

  function scan() {
    document.querySelectorAll('video').forEach(v => {
      if (v.readyState >= 1 || v.src || v.currentSrc) {
        ensureOverlay(v);
      }
    });
  }

  loadSaved(() => {
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 2000);
  });
})();
