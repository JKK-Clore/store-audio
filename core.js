(function () {
  'use strict';

  const BASE  = window.CLORE_BASE;
  const GMXHR = window.GM_xmlhttpRequest;

  if (!BASE) { console.error('[Clore Core] BASE 없음 — 로더 확인'); return; }

  fetch(`${BASE}/config.json?t=${Date.now()}`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(e => console.error('[Clore Core] config 로드 실패', e));

  function init(cfg) {
    const state = { adActive: false, skipHandled: false, fillerAudio: null, closedFlags: {} };
    const blobCache = {}; // url → objectURL

    // ━━━ 0. 오디오 프리로드 (CSP 우회: GM_xmlhttpRequest → Blob) ━━━
    const allTracks = [
      ...(cfg.audio?.tracks || []),
      ...cfg.closing.offsetsMin.map(m => `${cfg.closing.baseUrl}${m}m.mp3`),
    ];
    allTracks.forEach(preload);

    function preload(url) {
      if (!GMXHR) { blobCache[url] = url; return; } // 폴백: 직접 URL 사용
      GMXHR({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (res) => {
          const blob = new Blob([res.response], { type: 'audio/mpeg' });
          blobCache[url] = URL.createObjectURL(blob);
        },
        onerror: () => console.warn('[Clore Core] 오디오 프리로드 실패', url),
      });
    }

    function playOneShot(url, volume) {
      const src = blobCache[url] || url;
      const a = new Audio(src);
      a.volume = volume ?? 1;
      a.play().catch(e => console.warn('[Clore Core] 재생 실패', url, e));
    }

    // ━━━ 1. 광고 스킵 — 사람 유사 타이밍 클릭 (강제 currentTime 조작 없음) ━━━
    setInterval(() => {
      const btn = document.querySelector(cfg.adSkip.skipButtonSelectors.join(', '));
      if (btn && !state.skipHandled) {
        state.skipHandled = true;
        const delay = rand(cfg.adSkip.clickDelayMinMs, cfg.adSkip.clickDelayMaxMs);
        setTimeout(() => btn.click(), delay);
      }
    }, 500);

    // ━━━ 2. 광고 진입/종료 감지 → mute + 필러 방송 (요청 자체는 절대 차단 안 함) ━━━
    // 필러 오디오는 프로모 트랙을 그대로 재사용 (별도 파일 불필요)
    const adObserver = new MutationObserver(() => {
      const video = document.querySelector('video');
      const adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      if (!video) return;

      if (adShowing && !state.adActive) {
        state.adActive = true;
        state.skipHandled = false; // 다음 광고 대비 리셋
        video.muted = true;
        if (cfg.muteDuringAd?.enabled) playFiller();
      } else if (!adShowing && state.adActive) {
        state.adActive = false;
        stopFiller(cfg.muteDuringAd.fadeMs, () => { video.muted = false; });
      }
    });
    adObserver.observe(document.body, { childList: true, subtree: true });

    function playFiller() {
      const tracks = cfg.audio?.tracks;
      if (!tracks?.length) return;
      const url = tracks[Math.floor(Math.random() * tracks.length)];
      const a = new Audio(blobCache[url] || url);
      a.volume = 0;
      a.play().catch(() => {});
      state.fillerAudio = a;
      fadeTo(a, 1, cfg.muteDuringAd.fadeMs);
    }

    function stopFiller(fadeMs, onDone) {
      if (!state.fillerAudio) { onDone?.(); return; }
      const a = state.fillerAudio;
      state.fillerAudio = null;
      fadeTo(a, 0, fadeMs, () => { a.pause(); onDone?.(); });
    }

    // ━━━ 3. "계속 시청하시겠습니까" 팝업 자동 확인 (안전망) ━━━
    if (cfg.continueWatchingDialog?.enabled) {
      setInterval(() => {
        const official = document.querySelector('.ytp-confirm-dialog-renderer-button-primary');
        if (official) { official.click(); return; }
        const fallback = [...document.querySelectorAll('button')].find(b =>
          /^(yes|예)$/i.test((b.textContent || '').trim())
        );
        if (fallback && /paused|continue watching|일시정지/i.test(document.body.innerText || '')) {
          fallback.click();
        }
      }, cfg.continueWatchingDialog.pollMs);
    }

    // ━━━ 4. 프로모 방송 (주기 재생, 광고 중엔 스킵) ━━━
    if (cfg.audio?.enabled) {
      let idx = 0;
      setInterval(() => {
        if (state.adActive) return;
        const track = cfg.audio.tracks[idx % cfg.audio.tracks.length];
        idx++;
        playOneShot(track, cfg.audio.volume);
      }, cfg.audio.intervalMin * 60 * 1000);
    }

    // ━━━ 5. 마감 방송 (시즌별 스케줄, 30/15/5/2분 전) ━━━
    setInterval(() => checkClosing(cfg.closing), cfg.testMode ? 5000 : 30000);

    function checkClosing(closing) {
      const now = new Date();
      const target = getCloseTime(now, closing);
      const diffMin = (target - now) / 60000;
      closing.offsetsMin.forEach(min => {
        const key = `${now.toDateString()}_${min}`;
        if (Math.abs(diffMin - min) < 0.5 && !state.closedFlags[key]) {
          state.closedFlags[key] = true;
          playOneShot(`${closing.baseUrl}${min}m.mp3`, closing.volume);
        }
      });
    }

    function getCloseTime(now, closing) {
      const summer = isSummerSeason(now);
      const day = now.getDay(); // 0=Sun, 6=Sat
      const mode = summer ? closing.hours.summer : closing.hours.winter;
      const hm = day === 0 ? mode.sun : day === 6 ? mode.sat : mode.monFri;
      const [h, m] = hm.split(':').map(Number);
      const t = new Date(now);
      t.setHours(h, m, 0, 0);
      return t;
    }

    function isSummerSeason(now) {
      const year = now.getFullYear();
      const mayStart = firstMonday(year, 4);  // 5월
      const sepStart = firstMonday(year, 8);  // 9월
      return now >= mayStart && now < sepStart;
    }

    function firstMonday(year, monthIdx) {
      const d = new Date(year, monthIdx, 1);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      return d;
    }

    // ━━━ 유틸 ━━━
    function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    function fadeTo(audio, target, ms, onDone) {
      const steps = 10;
      const start = audio.volume;
      const stepMs = ms / steps;
      let i = 0;
      const t = setInterval(() => {
        i++;
        audio.volume = start + (target - start) * (i / steps);
        if (i >= steps) { clearInterval(t); onDone?.(); }
      }, stepMs);
    }

    console.log('[Clore Core] 로딩 완료 (전 지점 공통)');
  }
})();
