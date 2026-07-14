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
    const state = {
      adActive: false,
      fillerAudio: null, fillerGain: null, fillerSource: null,
      pendingUnmute: null, fillerChainActive: false, currentIsFiller: false,
      closedFlags: {}, lastAudioAt: Date.now(), storeClosed: false,
    };
    const blobCache = {}; // url → objectURL

    // ━━━ 0-A. 공용 AudioContext (누수·상한 도달로 인한 무음/지연 방지) ━━━
    // 기존: 재생마다 new AudioContext() + playChime()은 close()조차 없음 → 문서당 ctx 상한(~6개) 도달
    let sharedCtx = null;
    function getCtx() {
      if (!sharedCtx || sharedCtx.state === 'closed') {
        sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
      return sharedCtx;
    }

    const branchVolumeMultiplier = () => {
      const n = Number(window.CLORE_VOLUME_MULTIPLIER);
      return Number.isFinite(n) && n > 0 ? n : 1;
    };
    const safeGain = (v) => {
      const n = Number(v);
      const base = Number.isFinite(n) && n >= 0 ? n : 1;
      return base * branchVolumeMultiplier();
    };
    const duckLevel = () => {
      const n = Number(cfg.audio?.duckVolume);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05; // config에 없으면 기본 5%
    };

    // ━━━ 0-B. 오디오 프리로드 (CSP 우회: GM_xmlhttpRequest → Blob) ━━━
    const allTracks = [
      ...(cfg.audio?.tracks || []),
      ...(cfg.filler?.track ? [cfg.filler.track] : []),
      ...cfg.closing.offsetsMin.map(m => `${cfg.closing.baseUrl}${m}m.mp3`),
    ];
    allTracks.forEach(preload);

    function preload(url) {
      if (!GMXHR) { blobCache[url] = url; return; }
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

    // ━━━ 0-C. 재생 경로 단일화 ━━━
    // 기존 playOneShot / playClosingSet / startTrack 3중복을 여기 하나로 통합
    // 증폭 지연 해결: gain 확정 → ctx.resume() 완료 → canplaythrough 이후에만 play()
    function createTrack(url, volume, fadeInMs = 0) {
      return new Promise((resolve) => {
        const ctx = getCtx();
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.preload = 'auto';
        a.src = blobCache[url] || url;
        if (!blobCache[url]) console.warn('[Clore Core] blob 미준비, 원격 URL로 재생:', url);

        let source, gain;
        try {
          source = ctx.createMediaElementSource(a);
          gain   = ctx.createGain();
          source.connect(gain);
          gain.connect(ctx.destination);
        } catch (e) {
          console.warn('[Clore Core] 그래프 생성 실패', url, e);
          resolve(null);
          return;
        }

        const targetGain = safeGain(volume);
        gain.gain.value = fadeInMs > 0 ? 0.0001 : targetGain; // ★ play() 전에 확정

        let settled = false;
        const cleanup = () => { try { gain.disconnect(); source.disconnect(); } catch (_) {} };

        const start = () => {
          if (settled) return;
          settled = true;
          Promise.resolve(ctx.resume()).catch(() => {}).finally(() => {
            a.play().catch(e => console.warn('[Clore Core] 재생 실패', url, e));
            state.lastAudioAt = Date.now();
            if (fadeInMs > 0) fadeGainTo(gain, targetGain, fadeInMs);
            resolve({ audio: a, gain, source, cleanup });
          });
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
        setTimeout(start, 3000); // 안전망: canplaythrough 미발화 대비
      });
    }

    // 삼단 3음 차임 (공용 ctx 사용 → 누수 없음)
    function playChime() {
      return new Promise((resolve) => {
        const ctx = getCtx();
        const notes = [523, 659, 784];
        notes.forEach((freq, i) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t = ctx.currentTime + i * 0.35;
          gain.gain.setValueAtTime(0.4 * branchVolumeMultiplier(), t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.6);
          osc.addEventListener('ended', () => { try { gain.disconnect(); } catch (_) {} }, { once: true });
        });
        setTimeout(resolve, notes.length * 350 + 500);
      });
    }

    // ━━━ 0-D. 덕킹 (프로모/마감 안내 시 유튜브 음악 낮추기) ━━━
    // 기존에 정규 프로모 경로엔 덕킹이 아예 없었음 → 음악 위에 프로모가 그대로 겹쳐 나감
    const duck = { depth: 0, prevVol: 1, saved: false };

    function duckVideo() {
      const video = document.querySelector('video');
      duck.depth++;
      if (duck.depth > 1 || !video) return;
      if (video.muted) return; // 광고 뮤트 중이면 건드릴 필요 없음
      duck.prevVol = video.volume;
      duck.saved = true;
      fadeTo(video, duck.prevVol * duckLevel(), 400);
    }

    function unduckVideo() {
      duck.depth = Math.max(0, duck.depth - 1);
      if (duck.depth > 0 || !duck.saved) return;
      const video = document.querySelector('video');
      duck.saved = false;
      if (!video) return;
      fadeTo(video, duck.prevVol, 700);
    }

    // ━━━ 0-E. 프로모 / 마감 안내 (덕킹 포함) ━━━
    async function playPromoDucked(url, volume) {
      duckVideo();
      await playChime(); // 차임을 시작한 이상 내용까지 반드시 재생
      const t = await createTrack(url, volume);
      if (!t) { unduckVideo(); return; }
      t.audio.addEventListener('ended', unduckVideo, { once: true });
    }

    // 마감 안내 세트: (띵동 → 오디오) × repeat, 세트 사이 1초 간격
    async function playClosingSet(url, volume, repeat) {
      duckVideo();
      let count = 0;
      const step = async () => {
        count++;
        await playChime();
        const t = await createTrack(url, volume);
        if (!t) { unduckVideo(); return; }
        t.audio.addEventListener('ended', () => {
          if (count < repeat) setTimeout(step, 1000);
          else unduckVideo();
        }, { once: true });
      };
      step();
    }

    // ━━━ 1. 광고 진입/종료 감지 → mute + 필러 방송 ━━━
    let muteEnforcer = null;
    const wiredVideos = new WeakSet();

    // 백그라운드 탭에서 setInterval은 최소 1000ms로 클램프됨 → 폴링만으론 최대 1초 소리 샘
    // 이벤트는 스로틀 영향을 안 받으므로 이벤트가 1차, 폴링은 백업
    function wireMuteGuard(video) {
      if (wiredVideos.has(video)) return;
      wiredVideos.add(video);
      const forceMute = () => { if (state.adActive && !video.muted) video.muted = true; };
      video.addEventListener('volumechange', forceMute);
      video.addEventListener('play', forceMute);
      video.addEventListener('loadeddata', forceMute);
      video.addEventListener('playing', forceMute);
    }

    const adObserver = new MutationObserver(() => {
      const video = document.querySelector('video');
      const adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      if (!video) return;
      wireMuteGuard(video);

      if (adShowing && !state.adActive) {
        state.adActive = true;
        video.muted = true;
        muteEnforcer = setInterval(() => { if (!video.muted) video.muted = true; }, 250); // 백업
        if (cfg.muteDuringAd?.enabled && !state.storeClosed) playFiller();
      } else if (!adShowing && state.adActive) {
        state.adActive = false;
        const fadeMs = cfg.muteDuringAd.crossfadeMs || 700;

        const fadeInVideo = () => {
          clearInterval(muteEnforcer);
          muteEnforcer = null;
          // 덕킹 중에 광고가 끼어든 경우, 덕킹된 값(0.05)이 아니라 원래 볼륨으로 복귀해야 함
          const targetVolume = duck.saved ? duck.prevVol : (video.volume || 1);
          video.muted = false;
          video.volume = 0;
          fadeTo(video, targetVolume, fadeMs);
        };

        if (state.fillerChainActive && state.currentIsFiller && state.fillerAudio) {
          const filler     = state.fillerAudio;
          const fillerGain = state.fillerGain;
          const fillerSrc  = state.fillerSource;
          state.fillerAudio = null;
          state.fillerGain = null;
          state.fillerSource = null;
          state.fillerChainActive = false;
          state.pendingUnmute = null;
          fadeInVideo();
          fadeGainTo(fillerGain, 0, fadeMs, () => {
            filler.pause();
            try { fillerGain.disconnect(); fillerSrc.disconnect(); } catch (_) {}
          });
        } else if (state.fillerChainActive) {
          state.pendingUnmute = fadeInVideo; // 프로모(차임+내용) 구간은 끝까지 재생 후 언뮤트
        } else {
          fadeInVideo();
        }
      }
    });
    adObserver.observe(document.body, { childList: true, subtree: true });

    function isPromoActive(cfg) {
      const until = cfg.audio?.activeUntil;
      if (!until) return true;
      return new Date() <= new Date(`${until}T23:59:59`);
    }

    function playFiller() {
      if (state.fillerChainActive) return;
      state.fillerChainActive = true;

      const active = isPromoActive(cfg);
      const [promo1, promo2] = active ? (cfg.audio?.tracks || []) : [];
      const loopUrl = cfg.filler?.track;

      const sequence = [];
      if (promo1) sequence.push({ url: promo1, chime: true });
      if (loopUrl) sequence.push({ url: loopUrl, chime: false });
      if (promo2) sequence.push({ url: promo2, chime: true });
      const fallbackLoopUrl = loopUrl || sequence[sequence.length - 1]?.url;
      if (!sequence.length && !fallbackLoopUrl) { state.fillerChainActive = false; return; }

      let idx = 0;
      playNext();

      async function playNext() {
        // 직전 트랙 참조 정리 (차임 대기 구간에 stale 참조 남지 않게)
        state.fillerAudio = null;
        state.fillerGain = null;
        state.fillerSource = null;

        if (!state.adActive) {
          state.fillerChainActive = false;
          if (state.pendingUnmute) {
            const done = state.pendingUnmute;
            state.pendingUnmute = null;
            done();
          }
          return;
        }
        if (state.storeClosed) { state.fillerChainActive = false; return; }

        const step = idx < sequence.length ? sequence[idx] : { url: fallbackLoopUrl, chime: false };
        idx++;
        if (!step.url) { state.fillerChainActive = false; return; }

        if (step.chime) await playChime(); // promo1·promo2 앞에만 띵동

        state.currentIsFiller = !step.chime;
        const vol = step.chime ? cfg.audio?.volume : 1; // 프로모=cfg값, 필러=1 (둘 다 지점배율 적용)
        const t = await createTrack(step.url, vol, cfg.muteDuringAd.fadeMs);
        if (!t) { setTimeout(playNext, 500); return; } // 트랙 실패해도 체인 안 끊기게

        state.fillerAudio = t.audio;
        state.fillerGain = t.gain;
        state.fillerSource = t.source;
        t.audio.addEventListener('ended', playNext, { once: true });
      }
    }

    // ━━━ 2. "계속 시청하시겠습니까" 팝업 자동 확인 ━━━
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

    // ━━━ 3. 프로모 방송 — "마지막 방송 후 경과시간" 기준 + 덕킹 ━━━
    if (cfg.audio?.enabled) {
      let idx = 0;
      const gapMs = cfg.audio.intervalMin * 60 * 1000;
      setInterval(() => {
        if (!isPromoActive(cfg)) return;
        if (state.adActive) return;
        if (state.storeClosed) return;
        if (duck.depth > 0) return; // 이미 다른 안내 나가는 중이면 겹치지 않게
        if (Date.now() - state.lastAudioAt < gapMs) return;
        const track = cfg.audio.tracks[idx % cfg.audio.tracks.length];
        idx++;
        state.lastAudioAt = Date.now(); // 차임 대기 중 중복 트리거 방지
        playPromoDucked(track, cfg.audio.volume);
      }, 30000);
    }

    // ━━━ 4. 마감 방송 + 영업시간 외 정지 ━━━
    checkClosing(cfg.closing);
    setInterval(() => checkClosing(cfg.closing), 30000);

    // ━━━ 5. 탭 복귀 시 상태 재동기화 (스로틀로 놓친 판정 복구) ━━━
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      checkClosing(cfg.closing);
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (!state.adActive && !state.storeClosed && video.muted) video.muted = false;
      if (!state.adActive && duck.depth === 0 && duck.saved) {
        duck.saved = false;
        video.volume = duck.prevVol; // 페이드 중 스로틀로 멈춘 경우 즉시 복구
      }
    });

    // ━━━ 디버그 ━━━
    const globalTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    globalTarget.closeCheckNow = () => checkClosing(cfg.closing);

    globalTarget.playPromo = (n) => {
      const tracks = cfg.audio?.tracks || [];
      const url = tracks[(n - 1 + tracks.length) % tracks.length];
      if (!url) { console.warn('[Clore Core] promo 트랙 없음'); return; }
      console.log(`[Clore Core] promo${n} 덕킹 재생:`, url);
      playPromoDucked(url, cfg.audio.volume);
    };
    globalTarget.playFillerTest = () => {
      const video = document.querySelector('video');
      if (!video) { console.warn('[Clore Core] video 못 찾음'); return; }
      state.adActive = true;
      video.muted = true;
      console.log('[Clore Core] 필러체인 강제 시작');
      playFiller();
    };
    globalTarget.stopFillerTest = () => {
      const video = document.querySelector('video');
      state.adActive = false;
      if (video) video.muted = false;
      console.log('[Clore Core] 필러체인 강제 종료');
    };
    globalTarget.stateNow = () => {
      console.log('[Clore Core] state:', {
        adActive: state.adActive,
        storeClosed: state.storeClosed,
        fillerChainActive: state.fillerChainActive,
        hasFillerAudio: !!state.fillerAudio,
        hasPendingUnmute: !!state.pendingUnmute,
        duckDepth: duck.depth,
        ctxState: sharedCtx ? sharedCtx.state : 'none',
        tabVisible: document.visibilityState,
      });
    };

    const logBadge = (icon, label, bg) => {
      console.log(
        `%c${icon} ${label} → storeClosed=${state.storeClosed}`,
        `color:#fff;background:${bg};padding:2px 8px;border-radius:4px;font-weight:bold;`
      );
    };
    globalTarget.testClosed = () => {
      localStorage.setItem('clore_test_closed', 'closed');
      checkClosing(cfg.closing);
      logBadge('🔴', 'CLOSED 강제 적용', '#c0392b');
    };
    globalTarget.testOpen = () => {
      localStorage.setItem('clore_test_closed', 'open');
      checkClosing(cfg.closing);
      logBadge('🟢', 'OPEN 강제 적용', '#27ae60');
    };
    globalTarget.testClear = () => {
      localStorage.removeItem('clore_test_closed');
      checkClosing(cfg.closing);
      logBadge('⚪', '오버라이드 해제(실제시각 기준)', '#7f8c8d');
    };

    console.log(
      '[Clore Core] 노출 진단 — unsafeWindow존재:', typeof unsafeWindow !== 'undefined',
      '| window===globalTarget:', window === globalTarget,
      '| typeof window.testClear:', typeof window.testClear
    );

    function checkClosing(closing) {
      const now = new Date();
      const target = getCloseTime(now, closing);
      const diffMin = (target - now) / 60000;

      // 기존 |diffMin - min| < 0.5 는 엣지트리거 → 백그라운드 탭 스로틀 시 윈도우를 통째로 건너뜀
      // 2분 유예 레벨트리거로 변경: 타이머가 밀려도 놓치지 않고, 늦게 로드해도 과거 안내가 몰아치지 않음
      closing.offsetsMin.forEach(min => {
        const key = `${now.toDateString()}_${min}`;
        const inWindow = diffMin > 0 && diffMin <= min && diffMin > min - 2;
        if (inWindow && !state.closedFlags[key]) {
          state.closedFlags[key] = true;
          const repeat = min === 30 ? 1 : 2;
          playClosingSet(`${closing.baseUrl}${min}m.mp3`, closing.volume, repeat);
        }
      });

      const closed = isInClosedWindow(now, closing);
      const video = document.querySelector('video');
      if (closed && !state.storeClosed) {
        if (state.adActive) return;
        state.storeClosed = true;
        video?.pause();
      } else if (!closed && state.storeClosed) {
        state.storeClosed = false;
        video?.play().catch(() => {});
      }
    }

    function isInClosedWindow(now, closing) {
      const override = localStorage.getItem('clore_test_closed');
      if (override === 'closed') return true;
      if (override === 'open') return false;

      const close = getCloseTime(now, closing);
      const pauseMin = Math.max(...closing.offsetsMin);
      const pauseStart = new Date(close.getTime() - pauseMin * 60000);
      if (now >= pauseStart) return true;

      const [oh, om] = closing.openTime.split(':').map(Number);
      const todayOpen = new Date(now);
      todayOpen.setHours(oh, om, 0, 0);
      return now < todayOpen;
    }

    function getCloseTime(now, closing) {
      const summer = isSummerSeason(now);
      const day = now.getDay();
      const mode = summer ? closing.hours.summer : closing.hours.winter;
      const hm = day === 0 ? mode.sun : day === 6 ? mode.sat : mode.monFri;
      const [h, m] = hm.split(':').map(Number);
      const t = new Date(now);
      t.setHours(h, m, 0, 0);
      return t;
    }

    function isSummerSeason(now) {
      const year = now.getFullYear();
      const mayStart = firstMonday(year, 4);
      const sepStart = firstMonday(year, 8);
      return now >= mayStart && now < sepStart;
    }

    function firstMonday(year, monthIdx) {
      const d = new Date(year, monthIdx, 1);
      while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      return d;
    }

    // ━━━ 유틸 ━━━
    // 기존: steps 고정 → 백그라운드에서 stepMs가 1000ms로 클램프되면 700ms 페이드가 24초로 늘어남
    // 변경: 경과시간 기준 → 스로틀되면 계단만 거칠어지고 총 길이는 유지
    function fadeTo(el, target, ms, onDone) {
      const token = (el.__cloreFade = (el.__cloreFade || 0) + 1);
      const start = el.volume;
      const t0 = performance.now();
      (function tick() {
        if (el.__cloreFade !== token) return; // 새 페이드가 시작되면 이전 건 즉시 폐기
        const p = Math.min((performance.now() - t0) / ms, 1);
        const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
        el.volume = Math.min(1, Math.max(0, start + (target - start) * eased));
        if (p < 1) setTimeout(tick, 25);
        else onDone?.();
      })();
    }

    // GainNode 페이드는 오디오 스레드에서 스케줄 → 탭 상태와 무관하게 정확
    function fadeGainTo(gainNode, target, ms, onDone) {
      if (!gainNode) { onDone?.(); return; }
      const ctx = getCtx();
      const g = gainNode.gain;
      const t0 = ctx.currentTime;
      try {
        g.cancelScheduledValues(t0);
        g.setValueAtTime(Math.max(g.value, 0.0001), t0);
        g.linearRampToValueAtTime(Math.max(target, 0.0001), t0 + ms / 1000);
      } catch (e) {
        g.value = target;
      }
      if (onDone) setTimeout(onDone, ms + 60);
    }

    console.log('[Clore Core] 로딩 완료 v3 (전 지점 공통 / 백그라운드탭 대응)');
    console.log('[Clore Core] 테스트: testClosed() / testOpen() / testClear()');
    console.log('[Clore Core] 디버그: playPromo(1|2) / playFillerTest() / stopFillerTest() / stateNow()');
  }
})();
