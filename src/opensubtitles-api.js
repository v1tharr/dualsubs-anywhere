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