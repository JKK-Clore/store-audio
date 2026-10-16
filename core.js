(function () {
  'use strict';

  const BASE  = window.CLORE_BASE;
  const GMXHR = window.GM_xmlhttpRequest;
  if (!BASE) { return; }

  fetch(`${BASE}/config.json?t=${Date.now()}`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(e => void 0);

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
          return false;
        }
        const rtt = best.t1 - best.t0;
        const next = best.server + 500 + rtt / 2 - best.t1;
        if (Math.abs(next) > 12 * 3600 * 1000) {
          return false;
        }
        const shift = next - clockOffsetMs;
        clockOffsetMs = next;
        clockSyncOk = true;
        if (Math.abs(shift) > 5000) {
        } else {
        }
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
      syncClock('clock-jump');
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
      lastFillerUrl: '',
      nextFiller: '',
      lastAudioAt: monoNow(),
      closeSkipLogged: new Set(),
      tickSource: null,
      lastTickAt: 0,
      tickCounts: { interval: 0, audio: 0, visible: 0, manual: 0, boot: 0 },
    };
    const blobCache = {};
    const activeTracks = new Set();
    const CLOSE_LATE_MAX_MIN = 3;
    const TICK_MIN_GAP_MS = 400;
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
        try {
          if (typeof sharedCtx.addEventListener === 'function') {
            sharedCtx.addEventListener('statechange', () => armHeartbeat());
          }
        } catch (_) {}
      }
      if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
      return sharedCtx;
    }

    function silentSource(durSec, onEnded) {
      const ctx = sharedCtx;
      if (!ctx || ctx.state !== 'running') return null;
      try {
        const src = ctx.createConstantSource ? ctx.createConstantSource() : ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(ctx.destination);
        let fired = false;
        const done = () => {
          if (fired) return;
          fired = true;
          try { src.disconnect(); g.disconnect(); } catch (_) {}
          onEnded();
        };
        src.addEventListener('ended', done, { once: true });
        const t = ctx.currentTime;
        src.start(t);
        src.stop(t + durSec);
        return { cancel: () => { fired = true; try { src.disconnect(); g.disconnect(); } catch (_) {} } };
      } catch (e) {
        return null;
      }
    }
    function audioWait(ms) {
      return new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const hb = silentSource(ms / 1000, finish);
        timer = setTimeout(finish, hb ? ms + 2500 : ms);
      });
    }

    const hbState = { token: 0, armed: false, armedAt: 0, beats: 0 };
    function armHeartbeat() {
      const ctx = sharedCtx;
      if (!ctx || ctx.state !== 'running') return;
      if (hbState.armed && monoNow() - hbState.armedAt < 3000) return;
      const my = ++hbState.token;
      hbState.armed = true;
      hbState.armedAt = monoNow();
      const ok = silentSource(1, () => {
        if (my !== hbState.token) return;
        hbState.armed = false;
        hbState.beats += 1;
        armHeartbeat();
        runTick('audio');
      });
      if (!ok) hbState.armed = false;
    }
    const safeGain = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    };
    const withTimeout = (p, ms, fallback) =>
      Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

    const allTracks = [
      ...promoEntries().map(e => e.url),
      ...cfg.closing.offsetsMin.map(m => `${cfg.closing.baseUrl}${m}m.mp3`),
    ];
    allTracks.forEach(preload);
    state.nextFiller = pickFiller();
    if (state.nextFiller) preload(state.nextFiller);
    function preload(url) {
      if (!GMXHR) { blobCache[url] = url; return; }
      GMXHR({
        method: 'GET', url, responseType: 'arraybuffer',
        onload: (res) => {
          blobCache[url] = URL.createObjectURL(new Blob([res.response], { type: 'audio/mpeg' }));
        },
        onerror: () => void 0,
      });
    }

    const fadeSteps = new Set();
    function stepFades() { [...fadeSteps].forEach((f) => f()); }
    function fadeTo(el, target, ms, onDone) {
      const token = (el.__cloreFade = (el.__cloreFade || 0) + 1);
      el.__cloreFadeActive = true;
      const start = el.volume;
      const t0 = performance.now();
      let timer = null;
      const cancel = () => { fadeSteps.delete(step); clearTimeout(timer); };
      const step = () => {
        if (!fadeSteps.has(step)) return;
        if (el.__cloreFade !== token) { cancel(); return; }
        const p = Math.min((performance.now() - t0) / ms, 1);
        const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
        el.volume = Math.min(1, Math.max(0, start + (target - start) * eased));
        if (p < 1) return;
        cancel();
        el.__cloreFadeActive = false;
        onDone?.();
      };
      const loop = () => {
        if (!fadeSteps.has(step)) return;
        step();
        if (fadeSteps.has(step)) timer = setTimeout(loop, 25);
      };
      fadeSteps.add(step);
      loop();
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
        let timer;
        const finish = () => { clearTimeout(timer); resolve(); };
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
          osc.addEventListener('ended', () => {
            try { gain.disconnect(); } catch (_) {}
            if (i === notes.length - 1) finish();
          }, { once: true });
        });
        timer = setTimeout(finish, notes.length * 350 + 500 + (ctx.state === 'running' ? 2500 : 0));
      });
    }

    function createTrack(url, volume, fadeInMs = 0, kind = 'generic') {
      return new Promise((resolve) => {
        const ctx = getCtx();
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.preload = 'auto';
        a.src = blobCache[url] || url;
        if (!blobCache[url]) void 0;

        let source, gain;
        try {
          source = ctx.createMediaElementSource(a);
          gain   = ctx.createGain();
          source.connect(gain);
          gain.connect(ctx.destination);
        } catch (e) { resolve(null); return; }

        const targetGain = safeGain(volume);
        gain.gain.value = fadeInMs > 0 ? 0.0001 : targetGain;

        let settled = false;
        let track = null;
        const cleanup = () => {
          try { gain.disconnect(); source.disconnect(); } catch (_) {}
          if (track) activeTracks.delete(track);
        };
        const fail = (why) => {
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
              a.play().then(() => true, (e) => { return false; }),
              3000, false);
            if (!played) return fail('play() did not start');
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
          cleanup();
          resolve(null);
        }, { once: true });
        if (a.readyState >= 3) start();
        else {
          ['canplaythrough', 'canplay', 'loadeddata'].forEach((ev) => a.addEventListener(ev, start, { once: true }));
        }
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

    function promoEntries() {
      const list = Array.isArray(cfg.audio?.tracks) ? cfg.audio.tracks : [];
      return list.map((t) => (typeof t === 'string' ? { url: t } : t)).filter((t) => t && typeof t.url === 'string' && t.url);
    }
    function promoDay() {
      const d = nowReal();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function promoActiveUrls() {
      const day = promoDay();
      const DAY = /^\d{4}-\d{2}-\d{2}$/;
      const urls = [];
      for (const e of promoEntries()) {
        if (e.from && !(DAY.test(e.from) && day >= e.from)) continue;
        if (e.until && !(DAY.test(e.until) && day <= e.until)) continue;
        urls.push(e.url);
        if (urls.length === 2) break;
      }
      return urls;
    }

    async function playPromoUnit(n) {
      if (state.quiet) {
        return;
      }
      const token = state.stopToken;
      const url = promoActiveUrls()[n - 1];
      if (!url) {
        state.lastAudioAt = monoNow();
        return;
      }
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
      const repeat = min === 30 ? 1 : 2;
      let finished = false;
      const body = (async () => {
        const url = `${cfg.closing.baseUrl}${min}m.mp3`;
        stopNonCloseAudio(`close-${min}`);
        state.closePlaying = true;
        engageMute();
        let heard = 0;
        try {
          for (let i = 0; i < repeat; i++) {
            await playChime(cfg.closing?.volume);
            const t = await createTrack(url, cfg.closing?.volume, 0, 'close');
            if (t) { heard++; await waitTrackEnded(t.audio, 60000); }
            if (i < repeat - 1) await audioWait(1000);
          }
        } catch (e) {
          heard = 0;
        }
        return heard;
      })();
      const t0 = monoNow();
      const guard = new Promise((resolve) => {
        const check = () => {
          if (finished) return;
          if (monoNow() - t0 >= 180000) { resolve(-1); return; }
          setTimeout(check, 5000);
        };
        setTimeout(check, 5000);
      });
      const heard = await Promise.race([body, guard]);
      finished = true;
      state.closePlaying = false;
      if (isAdShowing()) {
        state.adActive = true;
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
      } else {
        restoreVideo(CROSS_MS());
      }
      if (heard < 0) { return false; }
      if (!heard) { return false; }
      return true;
    }

    function fillerUrls() {
      const f = cfg.filler || {};
      const toUrl = (x) => (/^https?:\/\//.test(x) ? x : `${BASE}/audio/filler/${x}`);
      if (Array.isArray(f.tracks)) {
        const list = f.tracks.filter((x) => typeof x === 'string' && x).map(toUrl);
        if (list.length) return list;
      }
      return f.track ? [f.track] : [];
    }
    function pickFiller() {
      const list = fillerUrls();
      if (list.length <= 1) return list[0] || '';
      const pool = list.filter((u) => u !== state.lastFillerUrl);
      return pool[Math.floor(Math.random() * pool.length)];
    }

    function playFillerOnce() {
      return new Promise(async (resolve) => {
        const url = state.nextFiller || pickFiller();
        if (!url) { resolve(false); return; }
        state.lastFillerUrl = url;
        state.nextFiller = pickFiller();
        if (state.nextFiller && !blobCache[state.nextFiller]) preload(state.nextFiller);
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
      let n = state.lastPromoType === 1 ? 2 : 1;
      if (n === 2 && promoActiveUrls().length < 2) n = 1;
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
      state.closeSkipLogged = new Set();
      state.lastDiffMin = null;
      const season = isSummerSeason(now) ? 'summer' : 'winter';
      const ct = getCloseTime(now);
      const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (state.playedCloseOffsets.size) {
      }
    }
    function stopPlaybackOnce(reason) {
      if (state.pauseDone) return;
      state.pauseDone = true;
      try { localStorage.setItem(PAUSE_LOG_KEY, state.closeDateKey); } catch (_) {}
      const video = document.querySelector('video');
      if (video && !video.paused) {
        try { video.pause(); } catch (_) {}
      } else {
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
    }
    function fireCloseOnce(min, reason) {
      if (state.playedCloseOffsets.has(min)) return;
      markClose(min);
      Promise.resolve(playClose(min)).then((ok) => {
        if (ok) { delete state.closeRetryAt[min]; return; }
        unmarkClose(min);
        state.closeRetryAt[min] = monoNow() + 20000;
      });
    }
    function evaluateClosingBroadcasts(diff) {
      if (diff <= 0) return;
      const offsets = [...cfg.closing.offsetsMin].sort((a, b) => b - a);
      let due = null;
      for (const min of offsets) {
        if (state.playedCloseOffsets.has(min)) continue;
        const nextSmaller = offsets.filter(m => m < min)[0] ?? 0;
        const lo = Math.max(min - CLOSE_LATE_MAX_MIN, nextSmaller);
        if (diff > min) continue;
        if (diff > lo) {
          const retryAt = state.closeRetryAt[min];
          if (retryAt && monoNow() < retryAt) continue;
          if (due === null) due = min;
          continue;
        }
        delete state.closeRetryAt[min];
        if (!state.closeSkipLogged.has(min)) {
          state.closeSkipLogged.add(min);
        }
      }
      if (due !== null && !state.closePlaying) fireCloseOnce(due, 'window');
    }

    function evaluateTick(source, force) {
      const mono = monoNow();
      if (!force && state.lastTickMono !== undefined && mono - state.lastTickMono < TICK_MIN_GAP_MS) return;
      state.lastTickMono = mono;
      state.lastTickAt = Date.now();
      const src = source || 'manual';
      state.tickSource = src;
      state.tickCounts[src] = (state.tickCounts[src] || 0) + 1;
      stepFades();
      detectClockJump();
      if (monoNow() - clockSyncedMono >= CLOCK_RESYNC_MS) syncClock('periodic-resync');
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
        } else {
          state.lastAudioAt = monoNow();
        }
      }

      if (closed && state.storeClosed !== true) {
        state.storeClosed = true;
        stopNonCloseAudio('storeClosed=true');
      } else if (!closed && state.storeClosed !== false) {
        const wasClosed = state.storeClosed === true;
        state.storeClosed = false;
        if (wasClosed) {
          state.lastAudioAt = monoNow();
        } else {
        }
      }

      if (diff > 0 && diff <= PAUSE_AT_MIN) {
        stopPlaybackOnce(`${PAUSE_AT_MIN} min before close`);
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
        } else if (cfg.audio?.enabled === false) {
        } else if (from && !(nowReal() >= new Date(`${from}T00:00:00`))) {
          const badFrom = Number.isNaN(new Date(`${from}T00:00:00`).getTime());
        } else {
          const malformed = !!until && Number.isNaN(new Date(`${until}T23:59:59`).getTime());
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
          /^(yes|\uC608)$/i.test((b.textContent || '').trim())
        );
        if (fallback && /paused|continue watching|\uC77C\uC2DC\uC815\uC9C0/i.test(document.body.innerText || '')) {
          fallback.click();
        }
      }
    }

    function evaluateMuteTick() {
      renderUnlockBadge();
      stepFades();
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
      unlockBadge.textContent = '🔇 Click to enable store audio';
      unlockBadge.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
        'padding:10px 16px', 'border-radius:8px', 'background:#c0392b', 'color:#fff',
        'font:bold 14px/1.2 system-ui,sans-serif', 'cursor:pointer',
        'box-shadow:0 2px 12px rgba(0,0,0,.5)',
      ].join(';');
      unlockBadge.addEventListener('click', unlockAudio);
      (document.body || document.documentElement).appendChild(unlockBadge);
    }
    function unlockAudio() {
      const ctx = getCtx();
      Promise.resolve(ctx.resume()).catch(() => {}).finally(() => { renderUnlockBadge(); armHeartbeat(); });
      setTimeout(renderUnlockBadge, 300);
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
    unlockAudio();

    const runTick = (source, force) => {
      try { evaluateTick(source, force); } catch (e) { }
    };
    const runMuteTick = () => {
      try { evaluateMuteTick(); } catch (e) { }
    };

    syncClock('boot').then(() => runTick('boot', true));

    runTick('boot', true);
    runMuteTick();
    syncAdState();

    setInterval(() => { armHeartbeat(); runTick('interval'); }, 1000);
    setInterval(runMuteTick, 250);
    armHeartbeat();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (monoNow() - clockSyncedMono > 60000) syncClock('tab-visible').then(() => runTick('visible', true));
      runTick('visible', true);
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (!state.muteHold && !state.adActive && video.muted) {
        video.muted = false;
      }
    });

    const globalTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const logBadge = (icon, label, bg) => {
    };

    globalTarget.testClosed = () => {
      localStorage.setItem('clore_test_closed', 'closed');
      runTick('manual', true);
    };
    globalTarget.testOpen = () => {
      localStorage.setItem('clore_test_closed', 'open');
      runTick('manual', true);
    };
    globalTarget.testClear = () => {
      localStorage.removeItem('clore_test_closed');
      runTick('manual', true);
    };

    globalTarget.playPromo = (n) => {
      (async () => {
        await playPromoUnit(n === 2 ? 2 : 1);
        if (!state.adActive && !state.closePlaying) restoreVideo(CROSS_MS());
      })();
    };
    globalTarget.playClose = (m) => {
      if (![30, 15, 5, 2].includes(m)) { return; }
      playClose(m);
    };

    globalTarget.simulateAd = (on) => {
      if (on) {
        if (state.adActive) { return; }
        state.adActive = true;
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
        if (state.adManaged && !state.unitPlaying && !state.chainActive && !state.closePlaying) {
          engageMute();
          if (!state.quiet) runAdChain(false);
        }
      } else {
        if (!state.adActive) { return; }
        state.adActive = false;
        state.adManaged = false;
        if (state.currentIsFiller && state.fillerAudio) {
          const g = state.fillerGain, a = state.fillerAudio, s = state.fillerSource;
          const wake = state.fillerResolve;
          fadeGainTo(g, 0, CROSS_MS(), () => { a.pause(); try { g.disconnect(); s.disconnect(); } catch (_) {} });
          if (wake) wake();
        }
        if (!state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      }
    };
    globalTarget.syncClock = () => syncClock('manual').then(() => globalTarget.stateNow());
    globalTarget.forceCloseLogClear = () => {
      localStorage.removeItem(CLOSE_LOG_KEY);
      localStorage.removeItem(PAUSE_LOG_KEY);
      state.playedCloseOffsets.clear();
      state.closeRetryAt = {};
      state.closeSkipLogged = new Set();
      state.pauseDone = false;
    };
    globalTarget.forceWatchdog = () => {
      state.lastAudioAt = monoNow() - (cfg.audio.intervalMin * 60 * 1000) - 1000;
    };
    globalTarget.stateNow = () => {
    };

  }
})();
