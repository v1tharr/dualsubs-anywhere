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
    return new TextDecoder('utf-8').decode(outBytes);
  }

  window.DualSubsZip = { listEntries, readEntry };
})();
