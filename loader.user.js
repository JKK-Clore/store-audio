// ==UserScript==
// @name         [Clore] Store Audio Loader
// @namespace    http://tampermonkey.net/clore
// @version      3.1
// @description  Loads the Clore store audio player (core.js and config.json). Same for every branch.
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const BASE = 'https://raw.githubusercontent.com/JKK-Clore/store-audio/main';
  unsafeWindow.CLORE_BASE = BASE;
  unsafeWindow.GM_xmlhttpRequest = GM_xmlhttpRequest;

  let ttPolicy = null;
  if (window.trustedTypes && trustedTypes.createPolicy) {
    try {
      ttPolicy = trustedTypes.createPolicy('clore-loader', {
        createScript: (s) => s,
      });
    } catch (e) {
    }
  } else {
  }

  function runCode(code) {
    const script = document.createElement('script');
    script.textContent = ttPolicy ? ttPolicy.createScript(code) : code;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  fetch(`${BASE}/core.js?t=${Date.now()}`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(code => { runCode(code); })
    .catch(e => void 0);
})();
