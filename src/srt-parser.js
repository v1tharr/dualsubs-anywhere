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
    const cueText = textLines.join('\n').trim();
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSRT, toSeconds, findCue };
} else {
  window.DualSubs = window.DualSubs || {};
  window.DualSubs.parseSRT = parseSRT;
  window.DualSubs.toSeconds = toSeconds;
  window.DualSubs.findCue = findCue;
}
