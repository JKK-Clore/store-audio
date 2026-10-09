// ==UserScript==
// @name         [Clore] Store Audio Loader
// @namespace    http://tampermonkey.net/clore
// @version      3.0
// @description  Auto_Audio_System:GitHub - core.js + config.json (전 지점 공통, 지점값 없음)
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';
  console.log('[Clore Loader] Tampermonkey on ✅ v3.0');

  const BASE = 'https://raw.githubusercontent.com/JKK-Clore/store-audio/main';
  unsafeWindow.CLORE_BASE = BASE;
  unsafeWindow.GM_xmlhttpRequest = GM_xmlhttpRequest;

  let ttPolicy = null;
  if (window.trustedTypes && trustedTypes.createPolicy) {
    try {
      ttPolicy = trustedTypes.createPolicy('clore-loader', {
        createScript: (s) => s,
      });
      console.log('[Clore Loader] Trusted Types 정책 생성 ✅');
    } catch (e) {
      console.warn('[Clore Loader] Trusted Types 정책 생성 실패 ❌', e);
    }
  } else {
    console.log('[Clore Loader] Trusted Types 미적용 페이지 — 정책 불필요 (정상)');
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
    .catch(e => console.error('[Clore Loader] core 로드 실패', e));
})();
