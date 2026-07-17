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
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 상태
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const state = {
      storeClosed: true,
      lastDiffMin: null,        // 교차감지용 — 최초 로드 tick은 기록만 (소급재생 안 함)
      pendingPause: false,      // 체인/유닛 완주 후 pause 적용 (State Lock-in)

      adActive: false,
      adManaged: false,         // 광고 시작 시점 storeClosed 스냅샷 (State Lock-in)

      chainActive: false,       // 광고체인 진행 중
      unitPlaying: false,       // 프로모 유닛(워치독 포함) 재생 중
      closePlaying: false,      // 마감방송 재생 중

      currentIsFiller: false,
      fillerAudio: null, fillerGain: null, fillerSource: null,
      fillerResolve: null,      // 필러 중단 시 while 루프 깨우기

      muteHold: false,          // 시스템이 뮤트를 유지해야 하는 구간
      prevVolume: 1,            // CF2 복원 목표값

      lastPromoType: 2,         // 마지막 프로모 (다음은 반대) — 초기 2 → 첫 워치독은 1
      lastAudioAt: Date.now(),  // 15분 공백 감시 시계 (프로모1/2만 갱신, 필러 안 침)
      workerAlive: false,       // true=Worker 정상가동, false=메인스레드 폴백
    };
    const blobCache = {};
    const CROSS_MS = () => cfg.muteDuringAd?.crossfadeMs || 700;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 공용 AudioContext + 볼륨 (지점배율 폐기 — config값 그대로)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 오디오 프리로드 (GM_xmlhttpRequest → Blob, CSP 우회)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 페이드 유틸 (v3 승계)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CF2 내부용 — 경과시간 기준이라 스로틀돼도 총 길이 유지
    function fadeTo(el, target, ms, onDone) {
      const token = (el.__cloreFade = (el.__cloreFade || 0) + 1);
      const start = el.volume;
      const t0 = performance.now();
      (function tick() {
        if (el.__cloreFade !== token) return;
        const p = Math.min((performance.now() - t0) / ms, 1);
        const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
        el.volume = Math.min(1, Math.max(0, start + (target - start) * eased));
        if (p < 1) setTimeout(tick, 25);
        else onDone?.();
      })();
    }
    // CF1 내부용 — 오디오 스레드 스케줄, 탭 상태 무관 정확
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // mute 걸기 / CF2 (유튜브 볼륨 복원 + unmute) — 멱등
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function engageMute() {
      const video = document.querySelector('video');
      if (!video) return;
      if (!state.muteHold) {
        state.prevVolume = video.volume > 0 ? video.volume : 1;
        state.muteHold = true;
      }
      video.muted = true; // 이미 true여도 무해 (멱등)
    }
    function restoreVideo(ms) { // = CF2
      if (!state.muteHold) return; // 멱등 — 이중호출 안전
      state.muteHold = false;
      const video = document.querySelector('video');
      if (!video) return;
      video.muted = false;
      video.volume = 0;
      fadeTo(video, state.prevVolume, ms || CROSS_MS());
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 침 (볼륨 = 해당 유닛 config값 따라감, 지점배율 없음)
    // 오실레이터 증폭은 클리핑 유발 → 0.4×volume, 상한 1.0
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 트랙 재생 (v3 승계 — gain 확정 → resume → canplaythrough 후 play)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function createTrack(url, volume, fadeInMs = 0) {
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
        const cleanup = () => { try { gain.disconnect(); source.disconnect(); } catch (_) {} };
        const start = () => {
          if (settled) return;
          settled = true;
          Promise.resolve(ctx.resume()).catch(() => {}).finally(() => {
            a.play().catch(e => console.warn('[Clore Core] 재생 실패', url, e));
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
        setTimeout(start, 3000);
      });
    }

    // ━━━ 트랙종료 대기 — 'ended' 또는 타임아웃 중 먼저 오는 쪽 (무기한 침묵 방지 안전판) ━━━
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
        const timer = setTimeout(() => {
          console.warn('[Clore Core] ⚠ 트랙 타임아웃(' + maxMs + 'ms) — 강제 종료 후 다음 단계로', audio.src);
          try { audio.pause(); } catch (_) {}
          finish();
        }, maxMs);
      });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Promo Unit (원자성: 침 + 트랙 + mute 한 몸) — unmute는 밖에서
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const isPromoActive = () => {
      const until = cfg.audio?.activeUntil;
      if (!until) return true;
      return new Date() <= new Date(`${until}T23:59:59`);
    };

    async function playPromoUnit(n) {
      const url = cfg.audio?.tracks?.[n - 1];
      if (!url) { console.warn(`[Clore Core] promo${n} 트랙 없음`); return; }
      state.unitPlaying = true;
      state.lastAudioAt = Date.now(); // 재생 시작 시점에도 갱신 (재생 중 워치독 중복트리거 방지)
      engageMute();
      await playChime(cfg.audio?.volume);
      const t = await createTrack(url, cfg.audio?.volume);
      if (t) await waitTrackEnded(t.audio, 60000);
      state.lastPromoType = n;
      state.lastAudioAt = Date.now(); // 종료 시점 갱신 → 여기서부터 15분 카운트
      state.unitPlaying = false;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 마감방송 유닛 — 30분=1회 / 15,5,2분=2연속 (mute 1번, CF2 1번)
    // storeClosed=true 예외로 항상 작동
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    async function playClose(min) {
      const url = `${cfg.closing.baseUrl}${min}m.mp3`;
      const repeat = min === 30 ? 1 : 2;
      state.closePlaying = true;
      engageMute();
      for (let i = 0; i < repeat; i++) {
        await playChime(cfg.closing?.volume);
        const t = await createTrack(url, cfg.closing?.volume);
        if (t) await waitTrackEnded(t.audio, 60000);
        if (i < repeat - 1) await new Promise(r => setTimeout(r, 1000));
      }
      state.closePlaying = false;
      restoreVideo(CROSS_MS()); // CF2 — pause 상태면 사실상 무해, 연장청취 중이면 자연 복원
      console.log(`[Clore Core] 마감 ${min}분 방송 완료 (${repeat}회)`);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 필러 1회 재생 — 중단 가능 (광고 끝나면 즉시 크로스페이드)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function playFillerOnce() {
      return new Promise(async (resolve) => {
        const url = cfg.filler?.track;
        if (!url) { resolve(); return; }
        const t = await createTrack(url, 1, cfg.muteDuringAd?.fadeMs || 300); // 필러 볼륨 고정 1
        if (!t) { setTimeout(resolve, 500); return; }
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
          resolve();
        };
        state.fillerResolve = finish; // 중단 경로 (observer/simulateAd가 호출)
        t.audio.addEventListener('ended', finish, { once: true });
        timer = setTimeout(() => {
          console.warn('[Clore Core] ⚠ 필러 타임아웃(300000ms) — 강제 종료 후 다음 단계로', url);
          try { t.audio.pause(); } catch (_) {}
          finish();
        }, 300000); // 5분 상한 — 필러는 배경트랙이라 프로모보다 길게 잡음
      });
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 광고체인: 프로모1 → 필러 → 프로모2 → 필러 무한 (광고 끝날 때까지)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    async function runAdChain(startAtFiller = false) {
      if (state.chainActive) return;
      state.chainActive = true;

      if (!startAtFiller && isPromoActive()) {
        await playPromoUnit(1); // 잠김 — 광고가 먼저 끝나도 완주
        if (!state.adActive) { restoreVideo(CROSS_MS()); finishChain(); return; }
      }

      let promo2Done = false;
      while (state.adActive) {
        await playFillerOnce(); // 자연종료 or 중단(observer가 크로스페이드+resolve)
        if (!state.adActive) break;
        if (!promo2Done && isPromoActive()) {
          await playPromoUnit(2); // 잠김
          promo2Done = true;
          if (!state.adActive) { restoreVideo(CROSS_MS()); break; }
        }
      }

      restoreVideo(CROSS_MS()); // 멱등 — 중단경로에서 이미 실행됐으면 no-op
      finishChain();
    }
    function finishChain() {
      state.chainActive = false;
      if (state.pendingPause && state.storeClosed) {
        document.querySelector('video')?.pause();
        state.pendingPause = false;
        console.log('[Clore Core] 체인 완주 후 pause 적용 (State Lock-in)');
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 워치독 프로모 (15분 공백 감시 발동)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    async function watchdogFire() {
      const n = state.lastPromoType === 1 ? 2 : 1; // 마지막의 반대
      console.log(`[Clore Core] 워치독 발동 → promo${n}`);
      await playPromoUnit(n);
      if (state.adActive && state.adManaged) {
        runAdChain(true); // 재생 도중 광고 시작됨 → 필러부터 체인 인계
      } else {
        restoreVideo(CROSS_MS()); // CF2
        if (state.pendingPause && state.storeClosed) {
          document.querySelector('video')?.pause();
          state.pendingPause = false;
        }
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 광고 감지 (MutationObserver — 스로틀 비대상, 감지는 이거 하나로 충분)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const wiredVideos = new WeakSet();
    function wireMuteGuard(video) { // 이벤트 기반 1차 안전망 (v3 승계)
      if (wiredVideos.has(video)) return;
      wiredVideos.add(video);
      const forceMute = () => { if (state.muteHold && !video.muted) video.muted = true; };
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
        // ── 광고 시작 ──
        state.adActive = true;
        state.adManaged = !state.storeClosed; // State Lock-in 스냅샷
        if (state.adManaged && cfg.muteDuringAd?.enabled) {
          if (state.unitPlaying || state.chainActive || state.closePlaying) {
            // 다른 유닛 재생 중 — muteHold 이미 걸려있음, 종료 시 각자 인계 처리
          } else {
            engageMute(); // 광고소리 즉시 컷 (침 시작 전 선제 뮤트)
            runAdChain(false);
          }
        }
        // unmanaged(storeClosed 중 시작) → 방치, 광고 끝날 때까지 개입 안 함
      } else if (!adShowing && state.adActive) {
        // ── 광고 종료 ──
        state.adActive = false;
        state.adManaged = false;
        if (state.currentIsFiller && state.fillerAudio) {
          // 필러 중단 — CF1 + CF2 동시 (진짜 크로스페이드)
          const g = state.fillerGain, a = state.fillerAudio, s = state.fillerSource;
          const wake = state.fillerResolve;
          fadeGainTo(g, 0, CROSS_MS(), () => {
            a.pause();
            try { g.disconnect(); s.disconnect(); } catch (_) {}
          });
          restoreVideo(CROSS_MS());
          if (wake) wake(); // while 루프 깨워서 정상 종료
        }
        // 프로모/마감 재생 중이면 → 아무것도 안 함 (완주 후 각자 CF2 처리, 이미 합의된 규칙)
      }
    });
    adObserver.observe(document.body, { childList: true, subtree: true });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 영업시간 계산 (확정 표: 여름 21/20/18, 겨울 20/19/18, 오픈 09:30·일 11:00)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // TICK 판정 (Worker 1초 tick마다 실행)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function evaluateTick() {
      const now = new Date();
      const diff = minsToClose(now);

      // 1) 마감방송 교차감지 — storeClosed 무관하게 항상 (예외 규정)
      //    첫 tick은 기록만 (지나친 안내 소급재생 안 함)
      if (state.lastDiffMin !== null) {
        cfg.closing.offsetsMin.forEach(min => {
          if (state.lastDiffMin > min && diff <= min && diff > 0) playClose(min);
        });
      }
      state.lastDiffMin = diff;

      // 2) storeClosed 판정 (override → 마감30분전 → 오픈전)
      const override = localStorage.getItem('clore_test_closed');
      let closed;
      if (override === 'closed') closed = true;
      else if (override === 'open') closed = false;
      else closed = (diff <= 30) || (now < getOpenTime(now));

      if (closed && !state.storeClosed) {
        state.storeClosed = true;
        if (state.chainActive || state.unitPlaying) {
          state.pendingPause = true; // 재생 유닛 완주 후 pause (State Lock-in)
        } else {
          document.querySelector('video')?.pause(); // 1회만 — 수동 재생은 안 막음
        }
        console.log('[Clore Core] storeClosed → true (올스탑, 마감방송만 예외)');
      } else if (!closed && state.storeClosed) {
        state.storeClosed = false;
        state.pendingPause = false;
        state.lastDiffMin = null; // 리셋 (false→true→false 전환 = 하루 경계)
        document.querySelector('video')?.play().catch(() => {});
        console.log('[Clore Core] storeClosed → false (재개장, 판정상태 리셋)');
      }

      // 3) 워치독 — 15분 프로모 공백 감시 (기존 TICK에 조건 하나, 별도 폴링 없음)
      if (cfg.audio?.enabled && isPromoActive()
          && !state.storeClosed && !state.adActive
          && !state.chainActive && !state.unitPlaying && !state.closePlaying
          && Date.now() - state.lastAudioAt >= cfg.audio.intervalMin * 60 * 1000) {
        watchdogFire();
      }

      // 4) Continue Watching 팝업 (v3 승계, storeClosed=true면 정지 — 올스탑 원칙)
      if (cfg.continueWatchingDialog?.enabled && !state.storeClosed) {
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

    // MUTE_TICK 판정 (Worker 250ms tick마다) — 백업 폴링 + 스킵버튼
    function evaluateMuteTick() {
      const video = document.querySelector('video');
      // 뮤트 백업 (이벤트가 1차, 이건 놓쳤을 때 최대 250ms 내 교정)
      if (state.muteHold && video && !video.muted) video.muted = true;
      // 광고 스킵 — 관리 대상 광고만 (adManaged 스냅샷 기준, State Lock-in)
      if (state.adActive && state.adManaged) {
        const skipBtn = document.querySelector(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, button.ytp-ad-skip-button-modern'
        );
        if (skipBtn) skipBtn.click();
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Web Worker (Dumb Clock — 인라인, 상태·판단·네트워크 없음)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
        // 안전망: Worker 생성 실패 시 메인스레드 타이머로 폴백 (스로틀 감수)
        state.workerAlive = false;
        console.warn('[Clore Core] Worker 생성 실패 — 메인스레드 폴백', e);
        setInterval(evaluateTick, 1000);
        setInterval(evaluateMuteTick, 250);
      }
    })();

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 탭 복귀 재동기화 (v3 승계 — Worker 메시지 유실 대비 이중 안전망)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      evaluateTick();
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (!state.muteHold && !state.adActive && !state.storeClosed && video.muted) {
        video.muted = false;
      }
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 콘솔 커맨드
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const globalTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const logBadge = (icon, label, bg) => {
      console.log(
        `%c${icon} ${label} → storeClosed=${state.storeClosed}`,
        `color:#fff;background:${bg};padding:2px 8px;border-radius:4px;font-weight:bold;`
      );
    };

    globalTarget.testClosed = () => {
      localStorage.setItem('clore_test_closed', 'closed');
      evaluateTick(); // 즉시 반영 (다음 TICK 안 기다림)
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
        if (!state.adActive) restoreVideo(CROSS_MS());
      })();
    };
    globalTarget.playClose = (m) => {
      if (![30, 15, 5, 2].includes(m)) { console.warn('[Clore Core] playClose(30|15|5|2)'); return; }
      playClose(m);
    };

    // ━━━ 디버그: 실제 광고/15분 대기 없이 체인·워치독 강제 재현 ━━━
    globalTarget.simulateAd = (on) => {
      if (on) {
        if (state.adActive) { console.warn('[Clore Core] 이미 adActive=true'); return; }
        state.adActive = true;
        state.adManaged = !state.storeClosed;
        console.log('[Clore Core] 🟠 광고 강제 시작 (시뮬레이션)');
        if (state.adManaged && cfg.muteDuringAd?.enabled
            && !state.unitPlaying && !state.chainActive && !state.closePlaying) {
          engageMute();
          runAdChain(false);
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
          restoreVideo(CROSS_MS());
          if (wake) wake();
        }
      }
    };
    globalTarget.forceWatchdog = () => {
      state.lastAudioAt = Date.now() - (cfg.audio.intervalMin * 60 * 1000) - 1000;
      console.log('[Clore Core] ⏱ lastAudioAt을 15분+ 전으로 조작 — 다음 TICK(≤1초)에 워치독 발동');
    };
    globalTarget.stateNow = () => {
      console.log('[Clore Core] state:', {
        workerAlive: state.workerAlive,
        storeClosed: state.storeClosed,
        adActive: state.adActive,
        adManaged: state.adManaged,
        chainActive: state.chainActive,
        unitPlaying: state.unitPlaying,
        closePlaying: state.closePlaying,
        currentIsFiller: state.currentIsFiller,
        muteHold: state.muteHold,
        lastPromoType: state.lastPromoType,
        minsSinceLastPromo: Math.round((Date.now() - state.lastAudioAt) / 60000),
        lastDiffMin: state.lastDiffMin === null ? null : Math.round(state.lastDiffMin * 10) / 10,
        tabVisible: document.visibilityState,
      });
    };

    console.log('[Clore Core] v4.0 로딩 완료 (Worker+교차감지+체인/워치독 통합)');
    console.log('[Clore Core] 테스트: testClosed() / testOpen() / testClear()');
    console.log('[Clore Core] 오디오: playPromo(1|2) / playClose(30|15|5|2) / stateNow()');
    console.log('[Clore Core] 체인/워치독 재현: simulateAd(true|false) / forceWatchdog()');
  }
})();
