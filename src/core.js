// Shared core: finds <video> elements, overlays two subtitle tracks with a
// small control panel. Storage-agnostic — relies on window.DualSubsStorage,
// which each adapter (webext / userscript) sets up before this file runs.

(function () {
  'use strict';

  const { parseSRT, findCue } = window.DualSubs;
  const STORAGE_KEY = 'dualsubs:' + location.hostname;

  let topCues = [], bottomCues = [];
  let topOffset = 0, bottomOffset = 0;
  let topBox, bottomBox, wrap, currentVideo;
  let visible = true;
  let activeSlot = null; // 'top' | 'bottom' — which slot a zip-picker choice applies to

  function loadSaved(callback) {
    window.DualSubsStorage.get(STORAGE_KEY, (data) => {
      if (data) {
        topCues = data.top || [];
        bottomCues = data.bottom || [];
        topOffset = data.topOffset || 0;
        bottomOffset = data.bottomOffset || 0;
        visible = data.visible !== false;
      }
      callback();
    });
  }

  function save() {
    window.DualSubsStorage.set(STORAGE_KEY, {
      top: topCues, bottom: bottomCues,
      topOffset, bottomOffset, visible
    });
  }

  function setVisible(v) {
    visible = v;
    if (wrap) wrap.style.display = visible ? 'flex' : 'none';
    save();
  }

  // ---------- file loading (.srt or .zip) ----------
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
        reader.onload = () => applyCues(activeSlot, reader.result);
        reader.readAsText(file, 'utf-8');
      }
    };
    input.click();
  }

  function applyCues(slot, text) {
    const cues = parseSRT(text);
    if (slot === 'top') topCues = cues; else bottomCues = cues;
    save();
  }

  function handleZip(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const zip = await window.JSZip.loadAsync(reader.result);
      const entries = Object.values(zip.files).filter(
        f => !f.dir && f.name.toLowerCase().endsWith('.srt')
      );
      if (entries.length === 0) {
        alert('No .srt files found inside this zip.');
        return;
      }
      showZipPicker(entries);
    };
    reader.readAsArrayBuffer(file);
  }

  function showZipPicker(entries) {
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

    entries.forEach(entry => {
      const row = document.createElement('div');
      row.textContent = entry.name;
      row.style.cssText = 'cursor:pointer; padding:6px 8px; border-radius:4px; word-break:break-all;';
      row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,0.15)');
      row.onmouseleave = () => (row.style.background = 'transparent');
      row.onclick = async () => {
        const text = await entry.async('string');
        applyCues(activeSlot, text);
        document.body.removeChild(overlay);
      };
      box.appendChild(row);
    });

    const cancel = document.createElement('div');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'cursor:pointer; margin-top:10px; text-align:center; opacity:0.7;';
    cancel.onclick = () => document.body.removeChild(overlay);
    box.appendChild(cancel);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ---------- panel UI ----------
  function buildPanel(container) {
    const btn = document.createElement('div');
    btn.textContent = 'CC';
    btn.title = 'Dual Subtitles (Alt+S to toggle)';
    btn.style.cssText = `
      position: absolute; top: 55%; left: 8px; z-index: 2147483647;
      background: rgba(0,0,0,0.6); color: #fff; font: bold 12px Arial, sans-serif;
      padding: 4px 8px; border-radius: 4px; cursor: pointer; user-select: none;
      pointer-events: auto;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      position: absolute; top: calc(55% + 26px); left: 8px; z-index: 2147483647;
      background: rgba(20,20,20,0.9); color: #fff; font: 13px Arial, sans-serif;
      padding: 8px; border-radius: 6px; display: none; flex-direction: column;
      gap: 6px; min-width: 200px; pointer-events: auto;
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

    panel.appendChild(mkRow('Load TOP subtitles (.srt/.zip)', () => pickFile('top')));
    panel.appendChild(mkRow('Load BOTTOM subtitles (.srt/.zip)', () => pickFile('bottom')));

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

    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 6px; cursor:pointer;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = visible;
    checkbox.onchange = () => setVisible(checkbox.checked);
    toggleRow.appendChild(checkbox);
    toggleRow.appendChild(document.createTextNode('Show subtitles'));
    panel.appendChild(toggleRow);

    panel.appendChild(mkRow('Clear subtitles', () => {
      topCues = []; bottomCues = []; topOffset = 0; bottomOffset = 0; save();
    }));

    btn.onclick = () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    };

    container.appendChild(btn);
    container.appendChild(panel);

    document.addEventListener('keydown', e => {
      if (e.altKey && e.key.toLowerCase() === 's') {
        checkbox.checked = !checkbox.checked;
        setVisible(checkbox.checked);
      }
    });
  }

  // ---------- video overlay ----------
  function ensureOverlay(video) {
    if (currentVideo === video && wrap && document.body.contains(wrap)) return;
    currentVideo = video;

    const container = video.parentElement;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    wrap = document.createElement('div');
    wrap.style.cssText = `
      position: absolute; left: 0; right: 0; bottom: 4%;
      pointer-events: none; z-index: 2147483647;
      display: ${visible ? 'flex' : 'none'}; flex-direction: column; align-items: center;
      font-family: Arial, sans-serif;
    `;

    topBox = document.createElement('div');
    bottomBox = document.createElement('div');
    for (const box of [topBox, bottomBox]) {
      box.style.cssText = `
        color: #fff; background: rgba(0,0,0,0.6);
        padding: 2px 10px; margin: 2px 0; border-radius: 4px;
        font-size: 20px; text-align: center; max-width: 90%;
        text-shadow: 1px 1px 2px #000; white-space: pre-line;
      `;
    }

    wrap.appendChild(topBox);
    wrap.appendChild(bottomBox);
    container.appendChild(wrap);
    buildPanel(container);

    video.addEventListener('timeupdate', updateSubs);
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
