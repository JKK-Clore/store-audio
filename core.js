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
    // 시계 계층 (시각판정 ≠ 경과시간)
    //  · nowReal() — 서버 보정 벽시계. 마감/오픈 판정은 전부 이걸 쓴다.
    //    매장 PC 시계가 수 분씩 밀려서(실측: 실제 21:00인데 20:57) 로컬 Date만 믿으면
    //    "30분 전 안내"가 실제로는 27분 남았을 때 나간다.
    //  · monoNow() — 단조시계. 경과시간(워치독 15분, 재시도 대기)은 전부 이걸 쓴다.
    //    벽시계로 재면 NTP 보정 점프에 워치독이 즉시 오발동하거나 영원히 잠든다.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const monoNow = () => performance.now();
    let clockOffsetMs = 0;       // nowReal = Date.now() + clockOffsetMs
    let clockSyncedMono = -Infinity;
    let clockSyncOk = false;
    let clockSyncing = false;
    const CLOCK_RESYNC_MS = 10 * 60 * 1000;
    const nowReal = () => new Date(Date.now() + clockOffsetMs);

    // GitHub 응답의 Date 헤더로 서버시각을 잡는다.
    // ⚠ Date는 CORS 안전목록 응답헤더가 아니고 GitHub는 access-control-expose-headers를
    //   보내지 않는다 → 페이지 fetch로는 헤더를 못 읽는다. 실동작 경로는 GMXHR 하나뿐이고,
    //   fetch 분기는 동일 오리진 테스트/폴백용이다. GMXHR이 없으면 로컬 시계로 폴백한다.
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
      clockSyncedMono = monoNow(); // 실패해도 즉시 재시도 폭주하지 않게 먼저 찍는다
      try {
        let best = null; // 왕복지연이 가장 짧은 표본이 가장 정확하다
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
        // Date 헤더는 초 단위 절삭 → 기댓값 +500ms. 응답 생성 시점은 왕복의 중간으로 본다.
        const next = best.server + 500 + rtt / 2 - best.t1;
        if (Math.abs(next) > 12 * 3600 * 1000) {
          console.warn(`[Clore Core] ⚠ 시각 오프셋 비정상(${Math.round(next / 1000)}초) — 무시`);
          return false;
        }
        const shift = next - clockOffsetMs;
        clockOffsetMs = next;
        clockSyncOk = true;
        // lastDiffMin은 일부러 보정하지 않는다. 보정 결과 임계점을 지나 있으면
        // 다음 tick의 교차감지가 그걸 정확히 한 번 발화시킨다(playedCloseOffsets가 중복 차단).
        const lv = Math.abs(shift) > 5000 ? 'warn' : 'log';
        console[lv](`[Clore Core] ⏱ 시각 동기화 (${reason}) — 로컬 시계 오차 ` +
          `${(clockOffsetMs / 1000).toFixed(1)}초, 이번 보정 ${(shift / 1000).toFixed(1)}초, RTT ${rtt}ms`);
        return true;
      } finally {
        clockSyncing = false;
        clockSyncedMono = monoNow();
      }
    }

    // 벽시계와 단조시계의 델타가 어긋나면 = 시스템 시계 점프 or 절전 복귀.
    let jumpWall = Date.now(), jumpMono = monoNow();
    function detectClockJump() {
      const wall = Date.now(), mono = monoNow();
      const skew = (wall - jumpWall) - (mono - jumpMono);
      jumpWall = wall; jumpMono = mono;
      if (Math.abs(skew) <= 5000) return;
      console.warn(`[Clore Core] ⚠ 시계 점프 감지 (${Math.round(skew / 1000)}초) — 즉시 재동기화`);
      syncClock('시계 점프');
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 마감방송 이력 영속화 (localStorage)
    // 메모리 Set만 쓰면 새로고침/SPA 재주입마다 하루치 이력이 날아가서,
    // catch-up 창 안에서 이미 나간 안내가 또 나가거나 창 밖이면 영영 안 나갔다.
    // 같은 오리진의 여러 유튜브 탭이 서로의 발화를 보게 되는 부수효과도 의도된 것이다.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

    // 자동 정지는 하루 딱 한 번이다. 메모리 플래그만 쓰면 새로고침·SPA 재주입마다
    // 되살아나서, 방송 재시도 루프를 타면 20초마다 직원이 튼 음악을 계속 꺼버린다.
    const PAUSE_LOG_KEY = 'clore_pause_done';
    const loadPauseDone = (dateKey) => {
      try { return localStorage.getItem(PAUSE_LOG_KEY) === dateKey; } catch (_) { return false; }
    };

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 상태
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const state = {
      storeClosed: null,       // null=부팅 직후 미동기화, 첫 tick에서 실제 시각으로 확정
      lastDiffMin: null,        // 교차감지용 — 최초 로드 tick은 기록만 (소급재생 안 함)
      closeDateKey: null,       // 날짜 바뀔 때 마감방송 중복 방지 상태 리셋
      playedCloseOffsets: new Set(),
      closeRetryAt: {},         // 재생 실패한 offset → 재시도 예정 시각 (무음 방송 구제)
      quiet: null,              // 마감 QUIET_FROM_MIN분 전부터 true — 우리 오디오 전면 정숙
      pauseDone: false,         // 그날 자동 정지(1회)를 이미 썼는지
      stopToken: 0,             // 마감 진입 시 진행 중인 광고/프로모 체인 취소
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

      promoActive: null,        // isPromoActive() 마지막 값 — 만료를 조용히 넘기지 않으려고 추적
      lastPromoType: 2,         // 마지막 프로모 (다음은 반대) — 초기 2 → 첫 워치독은 1
      lastAudioAt: monoNow(),   // 15분 공백 감시 — 단조시계 (시계 점프에 면역)
      workerAlive: false,       // true=Worker 정상가동, false=메인스레드 폴백
    };
    const blobCache = {};
    const activeTracks = new Set();
    const CLOSE_CATCHUP_MIN = 1.5; // 로드/복귀가 임계점 직후여도 해당 안내만 살림
    const CLOSE_LOCK_MIN = 30; // storeClosed 경계 — 오디오 판정용. YouTube 재생은 건드리지 않는다.
    // ━━━ 정숙 구간 ━━━
    // 마감 N분 전부터 '우리가 내보내는 소리'를 전부 막는다 — 프로모·워치독·필러.
    // 이미 재생 중인 건 하드컷하지 않고 자연 종료시킨다(필러 90초 + 프로모 25초 = 최대 2분).
    // 광고가 떠도 뮤트만 걸고 필러는 깔지 않으므로, 이 구간에 나가는 소리는 마감방송뿐이다.
    // YouTube 자체 재생에는 일절 개입하지 않는다.
    // quietFromMin이 정식 키. promoOffMin은 v4.1 배포본 호환용으로만 읽는다.
    const QUIET_FROM_MIN = Number.isFinite(Number(cfg.closing?.quietFromMin ?? cfg.closing?.promoOffMin))
      ? Number(cfg.closing.quietFromMin ?? cfg.closing.promoOffMin) : 40;
    // 하루 한 번 있는 자동 정지 시점(마감 N분 전). 이후 누가 다시 틀면 그대로 둔다.
    const PAUSE_AT_MIN = Number.isFinite(Number(cfg.closing?.pauseAtMin))
      ? Number(cfg.closing.pauseAtMin) : 15;
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
    // 영영 안 풀리는 Promise(자동재생 정책에 막힌 resume 등)를 끊는 안전판
    const withTimeout = (p, ms, fallback) =>
      Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

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
      el.__cloreFadeActive = true; // engageMute가 '중간값'을 캡처하지 않도록 알린다
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
        // CF2 페이드 도중의 video.volume은 0→목표로 올라가는 중간값이다. 그걸 캡처하면
        // 복원 목표가 사이클마다 낮아져 볼륨이 0으로 래칫된다. 페이드 중이면 직전 값을 지킨다.
        if (!video.__cloreFadeActive) {
          state.prevVolume = video.volume > 0 ? video.volume : 1;
        }
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
            // AudioContext.resume()은 자동재생 정책에 막히면 reject가 아니라 '무기한 pending'이다.
            // 그냥 매달리면 이 Promise가 영영 안 풀려 closePlaying/unitPlaying이 영구 고정된다.
            await withTimeout(Promise.resolve(ctx.resume()).catch(() => {}), 1500, null);
            // 판정 기준은 resume()의 결과가 아니라 ctx.state다 — 타임아웃 '직후' 풀리는 경우가 있다.
            // suspended ctx로 흘려보내면 element는 'ended'까지 정상 진행하는데 스피커로는 무음이고,
            // 이 '무음 성공' 위장이 마감방송이 씹히는 주경로다. 여기서 실패로 확정한다.
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
        audio.addEventListener('clorestop', finish, { once: true });
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
      state.lastAudioAt = monoNow(); // 재생 시작 시점에도 갱신 (재생 중 워치독 중복트리거 방지)
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
      state.lastAudioAt = monoNow(); // 종료 시점 갱신 → 여기서부터 15분 카운트
      state.unitPlaying = false;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 마감방송 유닛 — 30분=1회 / 15,5,2분=2연속 (mute 1번, CF2 1번)
    // storeClosed=true 예외로 항상 작동
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    async function playClose(min) {
      const url = `${cfg.closing.baseUrl}${min}m.mp3`;
      const repeat = min === 30 ? 1 : 2;
      // 마감방송은 무조건 단독으로 나간다. 정숙 구간(QUIET_FROM_MIN)이 이미 판을 비워두지만
      // 그건 시간 창일 뿐 보장이 아니다 — 서버시각 보정이 늦게 도착하거나 절전에서 깨어나면
      // 정숙 전환과 마감 임계점이 같은 tick에 몰릴 수 있다. 여기서 직접 치우고 시작한다.
      stopNonCloseAudio(`close-${min}`);
      state.closePlaying = true;
      engageMute();
      let heard = 0; // 실제로 스피커까지 나간 횟수 — 0이면 '완료'가 아니라 실패다
      for (let i = 0; i < repeat; i++) {
        await playChime(cfg.closing?.volume);
        const t = await createTrack(url, cfg.closing?.volume, 0, 'close');
        if (t) { heard++; await waitTrackEnded(t.audio, 60000); }
        if (i < repeat - 1) await new Promise(r => setTimeout(r, 1000));
      }
      state.closePlaying = false;
      // 뮤트 해제 + 볼륨 원복. 유튜브가 정지 상태여도 안전하고(소리 안 남),
      // 직원이 틀어놨다면 700ms 크로스페이드로 음악이 돌아온다.
      // 방송 사이에 광고가 시작됐을 수 있다(stopNonCloseAudio가 adActive를 0으로 내렸으므로
      // DOM을 직접 본다). 아직 광고 중이면 뮤트를 쥔 채 넘기고 종료 핸들러에 복원을 맡긴다.
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 필러 1회 재생 — 중단 가능 (광고 끝나면 즉시 크로스페이드)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function playFillerOnce() {
      return new Promise(async (resolve) => {
        const url = cfg.filler?.track;
        if (!url) { resolve(false); return; }
        const t = await createTrack(url, 1, cfg.muteDuringAd?.fadeMs || 300, 'filler'); // 필러 볼륨 고정 1
        // 실패해도 뮤트는 놓지 않는다 — 매장에 광고 소리가 새는 게 무음보다 나쁘다.
        // 뮤트 해제는 광고 종료 핸들러(syncAdState)가 책임진다.
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
      if (state.chainActive || state.quiet) return;
      const token = state.stopToken;
      state.chainActive = true;

      if (!startAtFiller && isPromoActive() && !state.quiet) {
        await playPromoUnit(1); // 잠김 — 광고가 먼저 끝나도 완주
        if (state.quiet || token !== state.stopToken) { finishChain(); return; }
        if (!state.adActive) { restoreVideo(CROSS_MS()); finishChain(); return; }
      }

      let promo2Done = false;
      let fillerFails = 0;
      while (state.adActive && !state.quiet && token === state.stopToken) {
        const ok = await playFillerOnce(); // 자연종료 or 중단(observer가 크로스페이드+resolve)
        // 필러가 연속으로 안 뜨면(AudioContext 잠김·네트워크) 3초마다 헛도는 루프가 된다.
        // 이 광고는 포기하고 뮤트만 유지한 채 빠진다 — 복원은 광고 종료 핸들러가 한다.
        if (!ok && ++fillerFails >= 2) {
          console.warn('[Clore Core] ⚠ 필러 연속 실패 — 이 광고는 뮤트만 유지');
          break;
        }
        if (!state.adActive || state.quiet || token !== state.stopToken) break;
        if (!promo2Done && isPromoActive() && !state.quiet) {
          await playPromoUnit(2); // 잠김
          promo2Done = true;
          if (state.quiet || token !== state.stopToken) break;
          if (!state.adActive) { restoreVideo(CROSS_MS()); break; }
        }
      }

      // 광고가 실제로 끝났을 때만 복원한다. 아직 광고 중이면 뮤트를 쥔 채 빠지고
      // syncAdState의 종료 분기가 풀어준다 — 여기서 풀면 광고 소리가 매장에 나간다.
      if (!state.adActive && !state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      finishChain();
    }
    function finishChain() {
      state.chainActive = false;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 워치독 프로모 (15분 공백 감시 발동)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    async function watchdogFire() {
      const n = state.lastPromoType === 1 ? 2 : 1; // 마지막의 반대
      console.log(`[Clore Core] 워치독 발동 → promo${n}`);
      await playPromoUnit(n);
      if (state.adActive && state.adManaged && !state.quiet) {
        runAdChain(true); // 재생 도중 광고 시작됨 → 필러부터 체인 인계
        return;
      }
      if (state.adActive) return;          // 광고 중 — 뮤트 유지, 종료 핸들러가 복원
      if (!state.closePlaying) restoreVideo(CROSS_MS()); // CF2
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 광고 감지 (MutationObserver — 스로틀 비대상)
    // YouTube의 ytp-ad-player-overlay는 광고가 아닐 때도 DOM에 남을 수 있다.
    // 실제 플레이어의 ad-showing 클래스만 광고로 인정한다.
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

    function isAdShowing() {
      return !!document.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing');
    }
    function syncAdState() {
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      // 시간 판정 전의 페이지 초기 DOM 변화는 광고 시작으로 처리하지 않는다.
      // evaluateTick() 뒤에 한 번 명시적으로 다시 동기화한다.
      if (state.storeClosed === null) return;
      const adShowing = isAdShowing();

      if (adShowing && !state.adActive) {
        // ── 광고 시작 ──
        state.adActive = true;
        // 시간대와 무관하게 광고는 '관리 대상'이다 — 최소한 뮤트는 건다.
        // 예전엔 storeClosed 중 시작한 광고를 방치해서, 마감 구간에 누가 유튜브를 틀면
        // 광고 소리가 그대로 매장에 나갔다.
        state.adManaged = cfg.muteDuringAd?.enabled !== false;
        if (state.adManaged) {
          if (state.unitPlaying || state.chainActive || state.closePlaying) {
            // 다른 유닛 재생 중 — muteHold 이미 걸려있음, 종료 시 각자 인계 처리
          } else {
            engageMute(); // 광고소리 즉시 컷 (침 시작 전 선제 뮤트)
            // 정숙 구간에선 뮤트만 건다. 필러를 깔면 마감방송과 겹칠 수 있다.
            if (!state.quiet) runAdChain(false);
          }
        }
      } else if (!adShowing && state.adActive) {
        // ── 광고 종료 ──
        state.adActive = false;
        state.adManaged = false;
        if (state.currentIsFiller && state.fillerAudio) {
          // 필러 중단 — CF1 (진짜 크로스페이드)
          const g = state.fillerGain, a = state.fillerAudio, s = state.fillerSource;
          const wake = state.fillerResolve;
          fadeGainTo(g, 0, CROSS_MS(), () => {
            a.pause();
            try { g.disconnect(); s.disconnect(); } catch (_) {}
          });
          if (wake) wake(); // while 루프 깨워서 정상 종료
        }
        // CF2는 필러가 있었든 없었든 무조건 돌린다.
        // 예전엔 이 복원이 위 if 안에 갇혀 있어서, 필러 생성이 실패하면(AudioContext 잠김 등)
        // currentIsFiller가 false로 남아 광고가 끝나도 뮤트가 안 풀렸다 — 볼륨 0 고착의 주경로.
        // 마감방송·프로모가 진행 중일 때만 양보한다(그쪽이 끝나며 각자 복원한다).
        if (!state.closePlaying && !state.unitPlaying) restoreVideo(CROSS_MS());
      }
    }
    const adObserver = new MutationObserver(syncAdState);
    // YouTube는 광고 전환 때 DOM을 추가하기도 하고, 플레이어의 ad-showing 클래스만 바꾸기도 한다.
    adObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 실제 종료 시각 (여름 21:00/20:00/18:00, 겨울 20:00/19:00/18:00)
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
      // 새로고침/재주입으로 메모리가 날아가도 그날 이미 나간 안내는 다시 나가지 않는다.
      state.playedCloseOffsets = loadCloseLog(key);
      state.closeRetryAt = {};
      state.pauseDone = loadPauseDone(key);
      state.lastDiffMin = null;
      if (state.playedCloseOffsets.size) {
        console.log('[Clore Core] 마감 이력 복원:', [...state.playedCloseOffsets].join(', ') + '분');
      }
    }
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 자동 정지 — 하루 딱 한 번 (마감 PAUSE_AT_MIN분 전)
    // 스크립트가 YouTube 재생에 개입하는 유일한 지점이다. 이후 누가 다시 틀면 그대로 둔다.
    // 마감 후 정리는 사람이 끄고 퇴근하는 것으로 합의됐다 — 스크립트는 다시 끄지 않는다.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      markClose(min); // 재생 중 중복 트리거 차단 — 실패하면 아래에서 되돌린다
      console.log(`[Clore Core] 마감 ${min}분 방송 트리거 (${reason})`);
      Promise.resolve(playClose(min)).then((ok) => {
        if (ok) { delete state.closeRetryAt[min]; return; }
        // 소리가 실제로 안 나갔다 — 마킹을 되돌리고 재시도 예약.
        // 예전엔 여기서 그냥 '완료'로 남아 그날 안내가 통째로 사라졌다.
        unmarkClose(min);
        state.closeRetryAt[min] = monoNow() + 20000;
        console.warn(`[Clore Core] ⚠ 마감 ${min}분 방송 실패 — 20초 뒤 재시도`);
      });
    }
    function evaluateClosingBroadcasts(diff) {
      if (diff <= 0) return;
      const offsets = [...cfg.closing.offsetsMin].sort((a, b) => b - a); // 내림차순

      // 실패한 안내 재시도 — 그 안내가 아직 유효한 구간(다음 offset 전)일 때만.
      for (const min of offsets) {
        if (!state.closeRetryAt[min] || state.playedCloseOffsets.has(min)) continue;
        const nextSmaller = offsets.filter(m => m < min)[0] ?? 0; // 내림차순이라 [0]이 최댓값
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
        // tick 공백(절전/프리즈/시계 점프)에 임계점이 여러 개 지나간 경우.
        // 가장 임박한 것만 재생하되 나머지도 '소비'로 기록한다 — 이전엔 마킹조차 안 돼
        // 조용히 사라진 뒤 재교차도 안 돼서 영구 누락이었다.
        crossed.filter(m => m !== due).forEach(m => {
          markClose(m);
          console.warn(`[Clore Core] ⚠ ${m}분 안내 건너뜀 — tick 공백 ${state.lastDiffMin.toFixed(1)}→${diff.toFixed(1)}분`);
        });
      }
      // Array#find는 대상이 없을 때 undefined를 반환한다.
      // undefined를 방송으로 넘기면 부팅 직후 'undefined분' 멘트가 2회 실행된다.
      if (Number.isFinite(due)) fireCloseOnce(due, state.lastDiffMin === null ? 'initial-catchup' : 'crossing');
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // TICK 판정 (Worker 1초 tick마다 실행)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function evaluateTick() {
      detectClockJump();
      if (monoNow() - clockSyncedMono >= CLOCK_RESYNC_MS) syncClock('주기 재동기화');
      const now = nowReal(); // 로컬 Date가 아니라 서버 보정 시각으로 판정한다
      syncCloseDate(now);
      const diff = minsToClose(now);

      // 1) storeClosed 판정 (override → 실제 종료 30분 전 → 오픈전)
      //    일반 오디오·자동재생은 전부 중단하고, 마감방송만 별도 예외로 남긴다.
      const override = localStorage.getItem('clore_test_closed');
      let closed;
      if (override === 'closed') closed = true;
      else if (override === 'open') closed = false;
      else closed = (diff <= CLOSE_LOCK_MIN) || (now < getOpenTime(now));

      // 2-1) 정숙 구간 — storeClosed보다 먼저 열린다 (기본: 마감 40분 전).
      //      프로모·워치독·필러를 전부 막는다. 이미 재생 중인 건 하드컷하지 않고 자연 종료
      //      시킨다 — 필러 90초 + 프로모 25초라 최대 2분이면 판이 완전히 빈다.
      //      광고는 뮤트만 걸리므로, 이 구간에 스피커로 나가는 소리는 마감방송뿐이다.
      //      YouTube 자체 재생에는 개입하지 않는다.
      const quiet = override === 'open' ? false : (closed || diff <= QUIET_FROM_MIN);
      if (quiet !== state.quiet) {
        const first = state.quiet === null;
        state.quiet = quiet;
        if (quiet) {
          console.log(`[Clore Core] quiet → true (${first ? '초기 동기화' : `마감 ${QUIET_FROM_MIN}분 전 진입`})`
            + ' — 프로모·워치독·필러 차단 / 광고는 뮤트만');
        } else {
          state.lastAudioAt = monoNow(); // 재개 즉시 워치독이 울지 않도록 새 주기
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
          // 날짜/오픈 감시는 계속 살아 있어야 다음 운영을 판정할 수 있다.
          // 전날 프로모 시각을 이어받으면 재오픈 즉시 워치독이 울리므로 새 15분 주기를 시작한다.
          state.lastDiffMin = null;
          state.lastAudioAt = monoNow();
          console.log('[Clore Core] storeClosed → false (재개장, 프로모 워치독 새 주기)');
        } else {
          console.log('[Clore Core] storeClosed → false (초기 동기화)');
        }
      }

      // 2-2) 자동 정지 — 마감 PAUSE_AT_MIN분 전을 '지나갈 때' 딱 한 번.
      //      교차로 판정한다. 첫 tick(lastDiffMin===null)은 발화하지 않으므로,
      //      그 시각이 지난 뒤 브라우저를 켠 사람의 재생을 빼앗지 않는다.
      //      하루 1회는 localStorage 플래그로 못박는다 — 새로고침이나 마감방송 재시도
      //      루프에 끌려 20초마다 직원이 튼 음악을 다시 끄면 안 된다.
      if (state.lastDiffMin !== null && diff > 0
          && state.lastDiffMin > PAUSE_AT_MIN && diff <= PAUSE_AT_MIN) {
        stopPlaybackOnce(`마감 ${PAUSE_AT_MIN}분 전`);
      }

      // 2-3) 마감방송 교차감지 — storeClosed 무관하게 항상 (예외 규정).
      //      playClose가 진입 시 스스로 판을 비우므로 이 호출 순서에 의존하지 않는다.
      evaluateClosingBroadcasts(diff);
      state.lastDiffMin = diff;

      // 3) 프로모 유효기간 — 만료는 조용히 지나가면 안 된다.
      //    activeUntil을 갱신하지 않아 프로모·워치독이 두 달 가까이 한 번도 안 나간 적이 있다.
      //    아무 로그도 없어서 아무도 몰랐다. 상태가 바뀌는 순간 눈에 띄게 남긴다.
      const promoActive = isPromoActive();
      if (promoActive !== state.promoActive) {
        const first = state.promoActive === null;
        const until = cfg.audio?.activeUntil;
        state.promoActive = promoActive;
        if (promoActive) {
          console.log(`[Clore Core] 프로모 활성 ${until ? `(activeUntil ${until})` : '(기한 없음)'}`);
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

      // 4) 워치독 — 15분 프로모 공백 감시 (기존 TICK에 조건 하나, 별도 폴링 없음)
      if (cfg.audio?.enabled && promoActive
          && !state.quiet && !state.adActive
          && !state.chainActive && !state.unitPlaying && !state.closePlaying
          && monoNow() - state.lastAudioAt >= cfg.audio.intervalMin * 60 * 1000) {
        watchdogFire();
      }

      // 5) Continue Watching 팝업 — 시간 조건 없이 항상 눌러준다.
      //    마감 후 재생은 직원이 의도적으로 튼 것이고, 끄고 퇴근하는 게 매장 원칙이다.
      //    스크립트가 팝업을 방치해서 대신 꺼주는 방식은 쓰지 않는다.
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

    // MUTE_TICK 판정 (Worker 250ms tick마다) — 백업 폴링 + 스킵버튼
    function evaluateMuteTick() {
      renderUnlockBadge(); // ctx가 죽었다 살아났다 하는 경우까지 추적
      const video = document.querySelector('video');
      // 정지 락은 폐기됐다 — YouTube 재생/정지는 사람 몫이고,
      // 스크립트의 개입은 stopPlaybackOnce() 하루 1회뿐이다.
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
    // 오디오 언락 게이트
    // 매장 PC의 메인 화면이 유튜브가 아니면 그 창은 제스처를 한 번도 못 받는다.
    // → AudioContext가 계속 suspended → 침·프로모·마감방송이 전부 무음으로 흘러간다.
    // 어떤 제스처든 잡히면 즉시 resume하고, 못 잡는 동안은 배지로 눈에 띄게 알린다.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      const ctx = getCtx(); // 내부에서 resume() 시도
      Promise.resolve(ctx.resume()).catch(() => {}).finally(renderUnlockBadge);
      setTimeout(renderUnlockBadge, 300);
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
    unlockAudio();

    // 부팅 즉시 시각 동기화. 응답 전 첫 tick은 로컬 시계로 돌지만, 보정이 도착하면
    // 그 다음 tick의 교차감지가 밀린 임계점을 정확히 한 번 따라잡는다.
    syncClock('부팅').then(() => evaluateTick());

    evaluateTick();
    evaluateMuteTick();
    syncAdState(); // 초기 DOM 상태도 시간 동기화 후 한 번만 판정

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
      // 절전/최대절전에서 깨어난 직후일 수 있다 — 시계부터 다시 맞춘다.
      // (alt-tab이 잦아도 네트워크를 때리지 않게 1분 스로틀)
      if (monoNow() - clockSyncedMono > 60000) syncClock('탭 복귀').then(() => evaluateTick());
      evaluateTick();
      const video = document.querySelector('video');
      if (!video) return;
      wireMuteGuard(video);
      if (!state.muteHold && !state.adActive && video.muted) {
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
        if (!state.adActive && !state.closePlaying) restoreVideo(CROSS_MS());
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
