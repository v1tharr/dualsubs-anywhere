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
