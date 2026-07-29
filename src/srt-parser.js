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
