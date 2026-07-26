// Content script: finds <video> elements, overlays two subtitle tracks,
// and provides a small floating control panel (left side, mid-lower —
// avoids native player controls that usually live in the corners).

(function () {
  'use strict';

  const { parseSRT, findCue } = window.DualSubs;
  const STORAGE_KEY = 'dualsubs:' + location.hostname;

  let topCues = [], bottomCues = [];
  let topBox, bottomBox, wrap, currentVideo;
  let visible = true;

  function loadSaved(callback) {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const data = result[STORAGE_KEY];
      if (data) {
        topCues = data.top || [];
        bottomCues = data.bottom || [];
        visible = data.visible !== false;
      }
      callback();
    });
  }

  function save() {
    chrome.storage.local.set({
      [STORAGE_KEY]: { top: topCues, bottom: bottomCues, visible }
    });
  }

  function setVisible(v) {
    visible = v;
    if (wrap) wrap.style.display = visible ? 'flex' : 'none';
    save();
  }

  function pickFile(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => callback(reader.result);
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  }

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
      gap: 6px; min-width: 170px; pointer-events: auto;
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

    panel.appendChild(mkRow('Load TOP subtitles', () =>
      pickFile(text => { topCues = parseSRT(text); save(); })));
    panel.appendChild(mkRow('Load BOTTOM subtitles', () =>
      pickFile(text => { bottomCues = parseSRT(text); save(); })));

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
      topCues = []; bottomCues = []; save();
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
    topBox.textContent = findCue(topCues, t);
    bottomBox.textContent = findCue(bottomCues, t);
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
