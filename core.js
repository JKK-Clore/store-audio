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
    const monoNow = () => performance.now();
    let clockOffsetMs = 0;
    let clockSyncedMono = -Infinity;
    let clockSyncOk = false;
    let clockSyncing = false;
    const CLOCK_RESYNC_MS = 10 * 60 * 1000;
    const nowReal = () => new Date(Date.now() + clockOffsetMs);

    function fetchServerDate() {
      const url = `${BASE}/config.json?clk=${Date.now()}`;
      const t0 = Date.now();
      if (GMXHR) {
        return new Promise((resolve) => {
          GMXHR({
            method: 'HEAD', url, timeout: 8000,
            headers: { 'Cache-Control': 'no-cache' },
            onload: (res) => {
              const m = /^date:\s*(.+)$/im.exec(res.responseHeaders || '');
              resolve(m ? { server: Date.parse(m[1].trim()), t0, t1: Date.now() } : null);
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
          });
        });
      }
      return fetch(url, { method: 'HEAD', cache: 'no-store' })
        .then(r => ({ server: Date.parse(r.headers.get('date') || ''), t0, t1: Date.now() }))
        .catch(() => null);
    }

    async function syncClock(reason) {
      if (clockSyncing) return false;
      clockSyncing = true;
      clockSyncedMono = monoNow();
      try {
        let best = null;
        for (let i = 0; i < 3; i++) {
          const s = await fetchServerDate();
          if (!s || !Number.isFinite(s.server)) continue;
          if (!best || (s.t1 - s.t0) < (best.t1 - best.t0)) best = s;
        }
        if (!best) {
          clockSyncOk = false;
          console.warn(`[Clore Core] ⚠ 시각 동기화 실패 (${reason}) — 로컬 시계로 계속 판정` +
            (GMXHR ? '' : ' | GM_xmlhttpRequest 없음: 로더의 @grant 확인 필요'));
          return false;
        }
        const rtt = best.t1 - best.t0;
        const next = best.server + 500 + rtt / 2 - best.t1;
        if (Math.abs(next) > 12 * 3600 * 1000) {
          console.warn(`[Clore Core] ⚠ 시각 오프셋 비정상(${Math.round(next / 1000)}초) — 무시`);
          return false;
        }
        const shift = next - clockOffsetMs;
        clockOffsetMs = next;
        clockSyncOk = true;
        const lv = Math.abs(shift) > 5000 ? 'warn' : 'log';
        console[lv](`[Clore Core] ⏱ 시각 동기화 (${reason}) — 로컬 시계 오차 ` +
          `${(clockOffsetMs / 1000).toFixed(1)}초, 이번 보정 ${(shift / 1000).toFixed(1)}초, RTT ${rtt}ms`);
        return true;
      } finally {
        clockSyncing = false;
        clockSyncedMono = monoNow();
      }
    }

    let jumpWall = Date.now(), jumpMono = monoNow();
    function detectClockJump() {
      const wall = Date.now(), mono = monoNow();
      const skew = (wall - jumpWall) - (mono - jumpMono);
      jumpWall = wall; jumpMono = mono;
      if (Math.abs(skew) <= 5000) return;
      console.warn(`[Clore Core] ⚠ 시계 점프 감지 (${Math.round(skew / 1000)}초) — 즉시 재동기화`);
      syncClock('시계 점프');
    }

    const CLOSE_LOG_KEY = 'clore_close_log';
    function loadCloseLog(dateKey) {
      try {
        const raw = JSON.parse(localStorage.getItem(CLOSE_LOG_KEY) || 'null');
        if (raw && raw.date === dateKey && Array.isArray(raw.done)) return new Set(raw.done);
      } catch (_) {}
      return new Set();
    }
    function saveCloseLog() {
      try {
        localStorage.setItem(CLOSE_LOG_KEY, JSON.stringify({
          date: state.closeDateKey, done: [...state.playedCloseOffsets],
        }));
      } catch (_) {}
    }
    const markClose   = (min) => { state.playedCloseOffsets.add(min);    saveCloseLog(); };
    const unmarkClose = (min) => { state.playedCloseOffsets.delete(min); saveCloseLog(); };

    const PAUSE_LOG_KEY = 'clore_pause_done';
    const loadPauseDone = (dateKey) => {
      try { return localStorage.getItem(PAUSE_LOG_KEY) === dateKey; } catch (_) { return false; }
    };

    const state = {
      storeClosed: null,
      lastDiffMin: null,
      closeDateKey: null,
      playedCloseOffsets: new Set(),
      closeRetryAt: {},
      quiet: null,
      pauseDone: false,
      stopToken: 0,
      adActive: false,
      adManaged: false,

      chainActive: false,
      unitPlaying: false,
      closePlaying: false,

      currentIsFiller: false,
      fillerAudio: null, fillerGain: null, fillerSource: null,
      fillerResolve: null,

      muteHold: false,
      prevVolume: 1,

      promoActive: null,
      lastPromoType: 2,
      lastAudioAt: monoNow(),
      workerAlive: false,
    };
    const blobCache = {};
    const activeTracks = new Set();
    const CLOSE_CATCHUP_MIN = 1.5;
    const CLOSE_LOCK_MIN = 30;
    const QUIET_FROM_MIN = Number.isFinite(Number(cfg.closing?.quietFromMin ?? cfg.closing?.promoOffMin))
      ? Number(cfg.closing.quietFromMin ?? cfg.closing.promoOffMin) : 40;
    const PAUSE_AT_MIN = Number.isFinite(Number(cfg.closing?.pauseAtMin))
      ? Number(cfg.closing.pauseAtMin) : 15;
    const CROSS_MS = () => cfg.muteDuringAd?.crossfadeMs || 700;

    let sharedCtx = null;
    function getCtx() {
      if (!sharedCtx || sharedCtx.state === 'closed') {
        sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
      return sharedCtx;
    }
    const safeGain = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    };
    const withTimeout = (p, ms, fallback) =>
      Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

    const allTracks = [
      ...(cfg.audio?.tracks || []),
      ...(cfg.filler?.track ? [cfg.filler.track] : []),
      ...cfg.closing.offsetsMin.map(m => `${cfg.closing.baseUrl}${m}m.mp3`),
    ];
    allTracks.forEach(preload);
    function preload(url) {
      if (!GMXHR) { blobCache[url] = url; return; }
      GMXHR({
        method: 'GET', url, responseType: 'arraybuffer',
        onload: (res) => {
          blobCache[url] = URL.createObjectURL(new Blob([res.response], { type: 'audio/mpeg' }));
        },
        onerror: () => console.warn('[Clore Core] 프리로드 실패', url),
      });
    }

    function fadeTo(el, target, ms, onDone) {
      const token = (el.__cloreFade = (el.__cloreFade || 0) + 1);
      el.__cloreFadeActive = true;
      const start = el.volume;
      const t0 = performance.now();
      (function tick() {
        if (el.__cloreFade !== token) return;
        const p = Math.min((performance.now() - t0) / ms, 1);
        const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
        el.volume = Math.min(1, Math.max(0, start + (target - start) * eased));
        if (p < 1) { setTimeout(tick, 25); return; }
        el.__cloreFadeActive = false;
        onDone?.();
      })();
    }
    function fadeGainTo(gainNode, target, ms, onDone) {
      if (!gainNode) { onDone?.(); return; }
      const ctx = getCtx();
      const g = gainNode.gain;
      const t0 = ctx.currentTime;
      try {
        g.cancelScheduledValues(t0);
        g.setValueAtTime(Math.max(g.value, 0.0001), t0);
        g.linearRampToValueAtTime(Math.max(target, 0.0001), t0 + ms / 1000);
      } catch (e) { g.value = target; }
      if (onDone) setTimeout(onDone, ms + 60);
    }

    function engageMute() {
      const video = document.querySelector('video');
      if (!video) return;
      if (!state.muteHold) {
        if (!video.__cloreFadeActive) {
          state.prevVolume = video.volume > 0 ? video.volume : 1;
        }
        state.muteHold = true;
      }
      video.muted = true;
    }
    function restoreVideo(ms) {
      if (!state.muteHold) return;
      state.muteHold = false;
      const video = document.querySelector('video');
      if (!video) return;
      video.muted = false;
      video.volume = 0;
      fadeTo(video, state.prevVolume, ms || CROSS_MS());
    }

    function playChime(volume) {
      return new Promise((resolve) => {
        const ctx = getCtx();
        const peak = Math.min(0.4 * safeGain(volume), 1.0);
        const notes = [523, 659, 784];
        notes.forEach((freq, i) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t = ctx.currentTime + i * 0.35;
          gain.gain.setValueAtTime(peak, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.6);
          osc.addEventListener('ended', () => { try { gain.disconnect(); } catch (_) {} }, { once: true });
        });
        setTimeout(resolve, notes.length * 350 + 500);
      });
    }

    function createTrack(url, volume, fadeInMs = 0, kind = 'generic') {
      return new Promise((resolve) => {
        const ctx = getCtx();
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.preload = 'auto';
        a.src = blobCache[url] || url;
        if (!blobCache[url]) console.warn('[Clore Core] blob 미준비 — 원격 재생:', url);

        let source, gain;
        try {
          source = ctx.createMediaElementSource(a);
          gain   = ctx.createGain();
          source.connect(gain);
          gain.connect(ctx.destination);
        } catch (e) { console.warn('[Clore Core] 그래프 생성 실패', url, e); resolve(null); return; }

        const targetGain = safeGain(volume);
        gain.gain.value = fadeInMs > 0 ? 0.0001 : targetGain;

        let settled = false;
        let track = null;
        const cleanup = () => {
          try { gain.disconnect(); source.disconnect(); } catch (_) {}
          if (track) activeTracks.delete(track);
        };
        const fail = (why) => {
          console.warn('[Clore Core] ⚠ 재생 실패 —', why, url);
          try { a.pause(); } catch (_) {}
          cleanup();
          resolve(null);
        };
        const start = () => {
          if (settled) return;
          settled = true;
          (async () => {
            await withTimeout(Promise.resolve(ctx.resume()).catch(() => {}), 1500, null);
            if (ctx.state !== 'running') return fail('AudioContext ' + ctx.state);
            const played = await withTimeout(
              a.play().then(() => true, (e) => { console.warn('[Clore Core] play() 거부', e); return false; }),
              3000, false);
            if (!played) return fail('play() 시작 안 됨');
            if (fadeInMs > 0) fadeGainTo(gain, targetGain, fadeInMs);
            track = {
              audio: a, gain, source, cleanup, kind,
              stopped: false,
              stop() {
                if (this.stopped) return;
                this.stopped = true;
                try { a.pause(); } catch (_) {}
                cleanup();
                try { a.dispatchEvent(new Event('clorestop')); } catch (_) {}
              },
            };
            activeTracks.add(track);
            resolve(track);
          })();
        };
        a.addEventListener('ended', cleanup, { once: true });
        a.addEventListener('error', () => {
          if (settled) return;
          settled = true;
          console.warn('[Clore Core] 오디오 에러', url);
          cleanup();
          resolve(null);
        }, { once: true });
        if (a.readyState >= 3) start();
        else a.addEventListener('canplaythrough', start, { once: true });
        setTimeout(start, 3000);
      });
    }

    function waitTrackEnded(audio, maxMs) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        audio.addEventListener('ended', finish, { once: true });
        audio.addEventListener('clorestop', finish, { once: true });
        const timer = setTimeout(() => {
          console.warn('[Clore Core] ⚠ 트랙 타임아웃(' + maxMs + 'ms) — 강제 종료 후 다음 단계로', audio.src);
          try { audio.pause(); } catch (_) {}
          finish();
        }, maxMs);
      });
    }

    const isPromoActive = () => {
      if (cfg.audio?.enabled === false) return false;
      const from = cfg.audio?.activeFrom;
      if (from && !(nowReal() >= new Date(`${from}T00:00:00`))) return false;
      const until = cfg.audio?.activeUntil;
      if (!until) return true;
      return nowReal() <= new Date(`${until}T23:59:59`);
    };

    async function playPromoUnit(n) {
      if (state.quiet) {
        console.log(`[Clore Core] quiet=true — promo${n} 재생 차단`);
        return;
      }
      const token = state.stopToken;
      const url = cfg.audio?.tracks?.[n - 1];
      if (!url) { console.warn(`[Clore Core] promo${n} 트랙 없음`); return; }
      state.unitPlaying = true;
      state.lastAudioAt = monoNow();
      engageMute();
      await playChime(cfg.audio?.volume);
      if (state.quiet || token !== state.stopToken) {
        state.unitPlaying = false;
        return;
      }
      const t = await createTrack(url, cfg.audio?.volume, 0, 'promo');
      if (t) await waitTrackEnded(t.audio, 60000);
      if (state.quiet || token !== state.stopToken) {
        state.unitPlaying = false;
        return;
      }
      state.lastPromoType = n;
      state.lastAudioAt = monoNow();
      state.unitPlaying = false;
    }

    async function playClose(min) {
      const url = `${cfg.closing.baseUrl}${min}m.mp3`;
      const repeat = min === 30 ? 1 : 2;
      stopNonCloseAudio(`close-${min}`);
      state.closePlaying = true;
      engageMute();
      let heard = 0;
      for (let i = 0; i < repeat; i++) {
        await playChime(cfg.closing?.volume);
        const t = await createTrack(url, cfg.closing?.volume, 0, 'close');
        if (t) { heard++; await waitTrackEnded(t.audio, 60000); }
        if (i < repeat - 1) await new Promise(r => setTimeout(r, 1000));
      }
      state.closePlaying = false;
      if (isAdShowing()) {
        state.adActive = true;
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
        console.log('[Clore Core] 마감방송 종료 시점에 광고 진행 중 — 뮤트 유지');
      } else {
        restoreVideo(CROSS_MS());
      }
      if (!heard) { console.warn(`[Clore Core] ⚠ 마감 ${min}분 방송 무음 (0/${repeat}회)`); return false; }
      console.log(`[Clore Core] 마감 ${min}분 방송 완료 (${heard}/${repeat}회)`);
      return true;
    }

    function playFillerOnce() {
      return new Promise(async (resolve) => {
        const url = cfg.filler?.track;
        if (!url) { resolve(false); return; }
        const t = await createTrack(url, 1, cfg.muteDuringAd?.fadeMs || 300, 'filler');
        if (!t) { setTimeout(() => resolve(false), 3000); return; }
        state.currentIsFiller = true;
        state.fillerAudio = t.audio;
        state.fillerGain  = t.gain;
        state.fillerSource = t.source;
        let timer;
        const finish = () => {
          clearTimeout(timer);
          state.currentIsFiller = false;
          state.fillerAudio = null; state.fillerGain = null; state.fillerSource = null;
          state.fillerResolve = null;
          resolve(true);
        };
        state.fillerResolve = finish;
        t.audio.addEventListener('ended', finish, { once: true });
        timer = setTimeout(() => {
          console.warn('[Clore Core] ⚠ 필러 타임아웃(300000ms) — 강제 종료 후 다음 단계로', url);
          try { t.audio.pause(); } catch (_) {}
          finish();
        }, 300000);
      });
    }

    async function runAdChain(startAtFiller = false) {
      if (state.chainActive || state.quiet) return;
      const token = state.stopToken;
      state.chainActive = true;

      if (!startAtFiller && isPromoActive() && !state.quiet) {
        await playPromoUnit(1);
        if (state.quiet || token !== state.stopToken) { finishChain(); return; }
        if (!state.adActive) { restoreVideo(CROSS_MS()); finishChain(); return; }
      }

      let promo2Done = false;
      let fillerFails = 0;
      while (state.adActive && !state.quiet && token === state.stopToken) {
        const ok = await playFillerOnce();
        if (!ok && ++fillerFails >= 2) {
          console.warn('[Clore Core] ⚠ 필러 연속 실패 — 이 광고는 뮤트만 유지');
          break;
        }
        if (!state.adActive || state.quiet || token !== state.stopToken) break;
        if (!promo2Done && isPromoActive() && !state.quiet) {
          await playPromoUnit(2);
          promo2Done = true;
          if (state.quiet || token !== state.stopToken) break;
          if (!state.adActive) { restoreVideo(CROSS_MS()); break; }
        }
      }

      if (!state.adActive && !state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      finishChain();
    }
    function finishChain() {
      state.chainActive = false;
    }

    async function watchdogFire() {
      const n = state.lastPromoType === 1 ? 2 : 1;
      console.log(`[Clore Core] 워치독 발동 → promo${n}`);
      await playPromoUnit(n);
      if (state.adActive && state.adManaged && !state.quiet) {
        runAdChain(true);
        return;
      }
      if (state.adActive) return;
      if (!state.closePlaying) restoreVideo(CROSS_MS());
    }

    const wiredVideos = new WeakSet();
    function wireMuteGuard(video) {
      if (wiredVideos.has(video)) return;
      wiredVideos.add(video);
      const forceMute = () => { if (state.muteHold && !video.muted) video.muted = true; };
      video.addEventListener('volumechange', forceMute);
      video.addEventListener('play', forceMute);
      video.addEventListener('loadeddata', forceMute);
      video.addEventListener('playing', forceMute);
    }

    function isAdShowing() {
      return !!document.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing');
    }
    function syncAdState() {
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (state.storeClosed === null) return;
      const adShowing = isAdShowing();

      if (adShowing && !state.adActive) {
        state.adActive = true;
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
        if (state.adManaged) {
          if (state.unitPlaying || state.chainActive || state.closePlaying) {
          } else {
            engageMute();
            if (!state.quiet) runAdChain(false);
          }
        }
      } else if (!adShowing && state.adActive) {
        state.adActive = false;
        state.adManaged = false;
        if (state.currentIsFiller && state.fillerAudio) {
          const g = state.fillerGain, a = state.fillerAudio, s = state.fillerSource;
          const wake = state.fillerResolve;
          fadeGainTo(g, 0, CROSS_MS(), () => {
            a.pause();
            try { g.disconnect(); s.disconnect(); } catch (_) {}
          });
          if (wake) wake();
        }
        if (!state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      }
    }
    const adObserver = new MutationObserver(syncAdState);
    adObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    function firstMonday(year, monthIdx) {
      const d = new Date(year, monthIdx, 1);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      return d;
    }
    function isSummerSeason(now) {
      const y = now.getFullYear();
      return now >= firstMonday(y, 4) && now < firstMonday(y, 8);
    }
    function getCloseTime(now) {
      const mode = isSummerSeason(now) ? cfg.closing.hours.summer : cfg.closing.hours.winter;
      const day = now.getDay();
      const hm = day === 0 ? mode.sun : day === 6 ? mode.sat : mode.monFri;
      const [h, m] = hm.split(':').map(Number);
      const t = new Date(now);
      t.setHours(h, m, 0, 0);
      return t;
    }
    function getOpenTime(now) {
      const hm = now.getDay() === 0 ? cfg.closing.open.sun : cfg.closing.open.monSat;
      const [h, m] = hm.split(':').map(Number);
      const t = new Date(now);
      t.setHours(h, m, 0, 0);
      return t;
    }
    function minsToClose(now) {
      return (getCloseTime(now) - now) / 60000;
    }
    function localDateKey(now) {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    function syncCloseDate(now) {
      const key = localDateKey(now);
      if (state.closeDateKey === key) return;
      state.closeDateKey = key;
      state.playedCloseOffsets = loadCloseLog(key);
      state.closeRetryAt = {};
      state.pauseDone = loadPauseDone(key);
      state.lastDiffMin = null;
      if (state.playedCloseOffsets.size) {
        console.log('[Clore Core] 마감 이력 복원:', [...state.playedCloseOffsets].join(', ') + '분');
      }
    }
    function stopPlaybackOnce(reason) {
      if (state.pauseDone) return;
      state.pauseDone = true;
      try { localStorage.setItem(PAUSE_LOG_KEY, state.closeDateKey); } catch (_) {}
      const video = document.querySelector('video');
      if (video && !video.paused) {
        try { video.pause(); } catch (_) {}
        console.log(`[Clore Core] ⏹ 자동 정지 (${reason}) — 이후 재생은 사람 몫`);
      } else {
        console.log(`[Clore Core] ⏹ 자동 정지 시점 (${reason}) — 이미 정지 상태`);
      }
    }
    function stopNonCloseAudio(reason) {
      state.stopToken += 1;
      for (const t of [...activeTracks]) {
        if (t.kind !== 'close') t.stop();
      }
      if (state.fillerResolve) state.fillerResolve();
      state.adActive = false;
      state.adManaged = false;
      state.chainActive = false;
      state.unitPlaying = false;
      state.currentIsFiller = false;
      console.log(`[Clore Core] 비마감 오디오 중단 (${reason})`);
    }
    function fireCloseOnce(min, reason) {
      if (state.playedCloseOffsets.has(min)) return;
      markClose(min);
      console.log(`[Clore Core] 마감 ${min}분 방송 트리거 (${reason})`);
      Promise.resolve(playClose(min)).then((ok) => {
        if (ok) { delete state.closeRetryAt[min]; return; }
        unmarkClose(min);
        state.closeRetryAt[min] = monoNow() + 20000;
        console.warn(`[Clore Core] ⚠ 마감 ${min}분 방송 실패 — 20초 뒤 재시도`);
      });
    }
    function evaluateClosingBroadcasts(diff) {
      if (diff <= 0) return;
      const offsets = [...cfg.closing.offsetsMin].sort((a, b) => b - a);

      for (const min of offsets) {
        if (!state.closeRetryAt[min] || state.playedCloseOffsets.has(min)) continue;
        const nextSmaller = offsets.filter(m => m < min)[0] ?? 0;
        if (diff > min || diff <= nextSmaller) { delete state.closeRetryAt[min]; continue; }
        if (monoNow() < state.closeRetryAt[min]) continue;
        delete state.closeRetryAt[min];
        fireCloseOnce(min, 'retry');
        return;
      }

      let due = null;
      if (state.lastDiffMin === null) {
        due = offsets.find(min => diff <= min && diff > min - CLOSE_CATCHUP_MIN);
      } else {
        const crossed = offsets.filter(min => state.lastDiffMin > min && diff <= min);
        due = crossed.length ? Math.min(...crossed) : null;
        crossed.filter(m => m !== due).forEach(m => {
          markClose(m);
          console.warn(`[Clore Core] ⚠ ${m}분 안내 건너뜀 — tick 공백 ${state.lastDiffMin.toFixed(1)}→${diff.toFixed(1)}분`);
        });
      }
      if (Number.isFinite(due)) fireCloseOnce(due, state.lastDiffMin === null ? 'initial-catchup' : 'crossing');
    }

    function evaluateTick() {
      detectClockJump();
      if (monoNow() - clockSyncedMono >= CLOCK_RESYNC_MS) syncClock('주기 재동기화');
      const now = nowReal();
      syncCloseDate(now);
      const diff = minsToClose(now);

      const override = localStorage.getItem('clore_test_closed');
      let closed;
      if (override === 'closed') closed = true;
      else if (override === 'open') closed = false;
      else closed = (diff <= CLOSE_LOCK_MIN) || (now < getOpenTime(now));

      const quiet = override === 'open' ? false : (closed || diff <= QUIET_FROM_MIN);
      if (quiet !== state.quiet) {
        const first = state.quiet === null;
        state.quiet = quiet;
        if (quiet) {
          console.log(`[Clore Core] quiet → true (${first ? '초기 동기화' : `마감 ${QUIET_FROM_MIN}분 전 진입`})`
            + ' — 프로모·워치독·필러 차단 / 광고는 뮤트만');
        } else {
          state.lastAudioAt = monoNow();
          console.log(`[Clore Core] quiet → false (${first ? '초기 동기화' : '영업 재개'})`);
        }
      }

      if (closed && state.storeClosed !== true) {
        state.storeClosed = true;
        stopNonCloseAudio('storeClosed=true');
        console.log('[Clore Core] storeClosed → true (우리 오디오만 정지 — YouTube 재생은 그대로)');
      } else if (!closed && state.storeClosed !== false) {
        const wasClosed = state.storeClosed === true;
        state.storeClosed = false;
        if (wasClosed) {
          state.lastDiffMin = null;
          state.lastAudioAt = monoNow();
          console.log('[Clore Core] storeClosed → false (재개장, 프로모 워치독 새 주기)');
        } else {
          console.log('[Clore Core] storeClosed → false (초기 동기화)');
        }
      }

      if (state.lastDiffMin !== null && diff > 0
          && state.lastDiffMin > PAUSE_AT_MIN && diff <= PAUSE_AT_MIN) {
        stopPlaybackOnce(`마감 ${PAUSE_AT_MIN}분 전`);
      }

      evaluateClosingBroadcasts(diff);
      state.lastDiffMin = diff;

      const promoActive = isPromoActive();
      if (promoActive !== state.promoActive) {
        const first = state.promoActive === null;
        const from = cfg.audio?.activeFrom;
        const until = cfg.audio?.activeUntil;
        state.promoActive = promoActive;
        if (promoActive) {
          console.log(`[Clore Core] 프로모 활성 ${from ? `(activeFrom ${from}) ` : ''}${until ? `(activeUntil ${until})` : '(기한 없음)'}`);
        } else if (cfg.audio?.enabled === false) {
          console.warn('[Clore Core] 프로모 꺼짐 — audio.enabled=false. promo1/2와 워치독이 나가지 않습니다. 필러·마감방송은 영향 없습니다.');
        } else if (from && !(nowReal() >= new Date(`${from}T00:00:00`))) {
          const badFrom = Number.isNaN(new Date(`${from}T00:00:00`).getTime());
          console.warn(`[Clore Core] 프로모 대기 — activeFrom ${badFrom ? `"${from}" 형식 오류` : `${from} 이전`}`
            + ` (${first ? '부팅 시점' : '방금'}). 시작일부터 promo1/2와 워치독이 나갑니다. 필러·마감방송은 영향 없습니다.`);
        } else {
          const malformed = !!until && Number.isNaN(new Date(`${until}T23:59:59`).getTime());
          console.warn(
            `%c⚠ 프로모 비활성 — activeUntil ${malformed ? `"${until}" 형식 오류` : `${until} 만료`}`,
            'color:#fff;background:#c0392b;padding:2px 8px;border-radius:4px;font-weight:bold;'
          );
          console.warn(`[Clore Core] promo1/2와 워치독이 나가지 않습니다 (${first ? '부팅 시점에 이미 만료' : '방금 만료됨'}).`
            + ' config.json의 audio.activeUntil을 갱신하세요. 필러·마감방송은 영향 없습니다.');
        }
      }

      if (cfg.audio?.enabled && promoActive
          && !state.quiet && !state.adActive
          && !state.chainActive && !state.unitPlaying && !state.closePlaying
          && monoNow() - state.lastAudioAt >= cfg.audio.intervalMin * 60 * 1000) {
        watchdogFire();
      }

      if (cfg.continueWatchingDialog?.enabled) {
        const official = document.querySelector('.ytp-confirm-dialog-renderer-button-primary');
        if (official) { official.click(); return; }
        const fallback = [...document.querySelectorAll('button')].find(b =>
          /^(yes|예)$/i.test((b.textContent || '').trim())
        );
        if (fallback && /paused|continue watching|일시정지/i.test(document.body.innerText || '')) {
          fallback.click();
        }
      }
    }

    function evaluateMuteTick() {
      renderUnlockBadge();
      const video = document.querySelector('video');
      if (state.muteHold && video && !video.muted) video.muted = true;
      if (state.adActive && state.adManaged) {
        const skipBtn = document.querySelector(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, button.ytp-ad-skip-button-modern'
        );
        if (skipBtn) skipBtn.click();
      }
    }

    let unlockBadge = null;
    function audioReady() { return !!sharedCtx && sharedCtx.state === 'running'; }
    function renderUnlockBadge() {
      if (audioReady()) {
        if (unlockBadge) { unlockBadge.remove(); unlockBadge = null; }
        return;
      }
      if (unlockBadge) return;
      unlockBadge = document.createElement('div');
      unlockBadge.textContent = '🔇 클릭해서 매장 방송 활성화';
      unlockBadge.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
        'padding:10px 16px', 'border-radius:8px', 'background:#c0392b', 'color:#fff',
        'font:bold 14px/1.2 system-ui,sans-serif', 'cursor:pointer',
        'box-shadow:0 2px 12px rgba(0,0,0,.5)',
      ].join(';');
      unlockBadge.addEventListener('click', unlockAudio);
      (document.body || document.documentElement).appendChild(unlockBadge);
      console.warn('[Clore Core] 🔇 AudioContext 잠김 — 이 창을 한 번 클릭해야 소리가 나갑니다');
    }
    function unlockAudio() {
      const ctx = getCtx();
      Promise.resolve(ctx.resume()).catch(() => {}).finally(renderUnlockBadge);
      setTimeout(renderUnlockBadge, 300);
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
    unlockAudio();

    syncClock('부팅').then(() => evaluateTick());

    evaluateTick();
    evaluateMuteTick();
    syncAdState();

    (function startWorker() {
      const workerSrc = [
        "setInterval(function(){ postMessage({type:'TICK'}); }, 1000);",
        "setInterval(function(){ postMessage({type:'MUTE_TICK'}); }, 250);",
      ].join('\n');
      try {
        const blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
        let workerUrl = blobUrl;
        if (window.trustedTypes && trustedTypes.createPolicy) {
          try {
            const p = trustedTypes.createPolicy('clore-worker', { createScriptURL: s => s });
            workerUrl = p.createScriptURL(blobUrl);
          } catch (_) {}
        }
        const worker = new Worker(workerUrl);
        worker.onmessage = (e) => {
          if (e.data?.type === 'TICK') evaluateTick();
          else if (e.data?.type === 'MUTE_TICK') evaluateMuteTick();
        };
        state.workerAlive = true;
        console.log('[Clore Core] Worker 가동 ✓ (백그라운드 스로틀 면역)');
      } catch (e) {
        state.workerAlive = false;
        console.warn('[Clore Core] Worker 생성 실패 — 메인스레드 폴백', e);
        setInterval(evaluateTick, 1000);
        setInterval(evaluateMuteTick, 250);
      }
    })();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (monoNow() - clockSyncedMono > 60000) syncClock('탭 복귀').then(() => evaluateTick());
      evaluateTick();
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (!state.muteHold && !state.adActive && video.muted) {
        video.muted = false;
      }
    });

    const globalTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const logBadge = (icon, label, bg) => {
      console.log(
        `%c${icon} ${label} → storeClosed=${state.storeClosed}`,
        `color:#fff;background:${bg};padding:2px 8px;border-radius:4px;font-weight:bold;`
      );
    };

    globalTarget.testClosed = () => {
      localStorage.setItem('clore_test_closed', 'closed');
      evaluateTick();
      logBadge('🔴', 'CLOSED 강제', '#c0392b');
    };
    globalTarget.testOpen = () => {
      localStorage.setItem('clore_test_closed', 'open');
      evaluateTick();
      logBadge('🟢', 'OPEN 강제', '#27ae60');
    };
    globalTarget.testClear = () => {
      localStorage.removeItem('clore_test_closed');
      evaluateTick();
      logBadge('⚪', '오버라이드 해제 (실제시각)', '#7f8c8d');
    };

    globalTarget.playPromo = (n) => {
      (async () => {
        await playPromoUnit(n === 2 ? 2 : 1);
        if (!state.adActive && !state.closePlaying) restoreVideo(CROSS_MS());
      })();
    };
    globalTarget.playClose = (m) => {
      if (![30, 15, 5, 2].includes(m)) { console.warn('[Clore Core] playClose(30|15|5|2)'); return; }
      playClose(m);
    };

    globalTarget.simulateAd = (on) => {
      if (on) {
        if (state.adActive) { console.warn('[Clore Core] 이미 adActive=true'); return; }
        state.adActive = true;
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
        console.log('[Clore Core] 🟠 광고 강제 시작 (시뮬레이션)');
        if (state.adManaged && !state.unitPlaying && !state.chainActive && !state.closePlaying) {
          engageMute();
          if (!state.quiet) runAdChain(false);
        }
      } else {
        if (!state.adActive) { console.warn('[Clore Core] adActive 이미 false'); return; }
        state.adActive = false;
        state.adManaged = false;
        console.log('[Clore Core] 🟢 광고 강제 종료 (시뮬레이션)');
        if (state.currentIsFiller && state.fillerAudio) {
          const g = state.fillerGain, a = state.fillerAudio, s = state.fillerSource;
          const wake = state.fillerResolve;
          fadeGainTo(g, 0, CROSS_MS(), () => { a.pause(); try { g.disconnect(); s.disconnect(); } catch (_) {} });
          if (wake) wake();
        }
        if (!state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      }
    };
    globalTarget.syncClock = () => syncClock('수동').then(() => globalTarget.stateNow());
    globalTarget.forceCloseLogClear = () => {
      localStorage.removeItem(CLOSE_LOG_KEY);
      localStorage.removeItem(PAUSE_LOG_KEY);
      state.playedCloseOffsets.clear();
      state.closeRetryAt = {};
      state.pauseDone = false;
      console.log('[Clore Core] 마감 이력·자동정지 플래그 초기화 — 오늘 것을 처음부터 다시 판정');
    };
    globalTarget.forceWatchdog = () => {
      state.lastAudioAt = monoNow() - (cfg.audio.intervalMin * 60 * 1000) - 1000;
      console.log('[Clore Core] ⏱ lastAudioAt을 15분+ 전으로 조작 — 다음 TICK(≤1초)에 워치독 발동');
    };
    globalTarget.stateNow = () => {
      console.log('[Clore Core] state:', {
        workerAlive: state.workerAlive,
        storeClosed: state.storeClosed,
        quiet: state.quiet,
        pauseDone: state.pauseDone,
        videoPaused: document.querySelector('video')?.paused ?? null,
        clockOffsetSec: Math.round(clockOffsetMs / 100) / 10,
        clockSyncOk,
        realNow: nowReal().toLocaleString('ko-KR'),
        localNow: new Date().toLocaleString('ko-KR'),
        audioCtxState: sharedCtx ? sharedCtx.state : 'none',
        closeRetryAt: Object.keys(state.closeRetryAt),
        playedCloseOffsets: [...state.playedCloseOffsets],
        adActive: state.adActive,
        adManaged: state.adManaged,
        chainActive: state.chainActive,
        unitPlaying: state.unitPlaying,
        closePlaying: state.closePlaying,
        currentIsFiller: state.currentIsFiller,
        muteHold: state.muteHold,
        promoActive: state.promoActive,
        activeFrom: cfg.audio?.activeFrom ?? null,
        activeUntil: cfg.audio?.activeUntil ?? null,
        lastPromoType: state.lastPromoType,
        minsSinceLastPromo: Math.round((monoNow() - state.lastAudioAt) / 60000),
        lastDiffMin: state.lastDiffMin === null ? null : Math.round(state.lastDiffMin * 10) / 10,
        tabVisible: document.visibilityState,
      });
    };

    console.log(`[Clore Core] v4.2 로딩 완료 — 정숙구간 ${QUIET_FROM_MIN}분 / 자동정지 ${PAUSE_AT_MIN}분 전 1회 / YouTube 정지락 폐기`);
    console.log('[Clore Core] 테스트: testClosed() / testOpen() / testClear()');
    console.log('[Clore Core] 오디오: playPromo(1|2) / playClose(30|15|5|2) / stateNow()');
    console.log('[Clore Core] 체인/워치독 재현: simulateAd(true|false) / forceWatchdog()');
    console.log('[Clore Core] 시각/이력: syncClock() / forceCloseLogClear()');
  }
})();
