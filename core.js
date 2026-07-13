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
    const state = { adActive: false, fillerAudio: null, closedFlags: {}, lastAudioAt: Date.now(), storeClosed: false };
    const blobCache = {}; // url → objectURL

    // ━━━ 0. 오디오 프리로드 (CSP 우회: GM_xmlhttpRequest → Blob) ━━━
    const allTracks = [
      ...(cfg.audio?.tracks || []),
      ...(cfg.filler?.track ? [cfg.filler.track] : []),
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
      state.lastAudioAt = Date.now(); // 프로모/마감 공통 타임스탬프
    }

    // 띵동 2음 차임 (합성음, 별도 파일 불필요)
    function playChime() {
      return new Promise((resolve) => {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [659, 523]; // 띵(E5) → 동(C5)
        notes.forEach((freq, i) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t = ctx.currentTime + i * 0.35;
          gain.gain.setValueAtTime(0.4, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.6);
        });
        setTimeout(resolve, notes.length * 350 + 500);
      });
    }

    // 마감 안내 세트: (띵동 → 오디오) × repeat, 세트 사이 1초 간격
    function playClosingSet(url, volume, repeat) {
      let count = 0;
      playOnce();

      function playOnce() {
        count++;
        playChime().then(() => {
          const src = blobCache[url] || url;
          const a = new Audio(src);
          a.volume = volume ?? 1;
          a.play().catch(e => console.warn('[Clore Core] 마감 안내 재생 실패', url, e));
          state.lastAudioAt = Date.now();
          if (count < repeat) {
            a.addEventListener('ended', () => setTimeout(playOnce, 1000));
          }
        });
      }
    }

    // ━━━ 1. 광고 진입/종료 감지 → mute + 필러 방송 (클릭/차단 없음, 광고는 자연 재생·자연 종료) ━━━
    // 필러 오디오는 프로모 트랙을 그대로 재사용 (별도 파일 불필요)
    let muteEnforcer = null;

    const adObserver = new MutationObserver(() => {
      const video = document.querySelector('video');
      const adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      if (!video) return;

      if (adShowing && !state.adActive) {
        state.adActive = true;
        video.muted = true;
        // 광고풀 내부에서 광고가 바뀔 때 유튜브가 muted를 자체적으로 리셋하는 경우가 있어서
        // loadstart 이벤트로는 안 잡혀서(MSE 방식이라 새 리소스 로드 자체가 안 뜸), 폴링으로 강제 유지
        muteEnforcer = setInterval(() => { if (!video.muted) video.muted = true; }, 250);
        if (cfg.muteDuringAd?.enabled && !state.storeClosed) playFiller();
      } else if (!adShowing && state.adActive) {
        state.adActive = false;
        clearInterval(muteEnforcer);
        muteEnforcer = null;
        stopFiller(cfg.muteDuringAd.fadeMs, () => { video.muted = false; });
      }
    });
    adObserver.observe(document.body, { childList: true, subtree: true });

    function playFiller() {
      const introTracks = cfg.audio?.tracks || []; // 고정 순서: promo1 → promo2
      const loopUrl = cfg.filler?.track; // 그 이후엔 이 트랙만 반복
      if (!introTracks.length && !loopUrl) return;
      let idx = 0;
      playNext();

      function playNext() {
        if (!state.adActive) return; // 광고가 이미 끝났으면 체인 중단
        if (state.storeClosed) return; // 재생 도중 마감 전환되면 체인 중단 (조용히 뮤트만 유지)
        const isIntro = idx < introTracks.length; // promo1, promo2 구간인지
        const url = isIntro ? introTracks[idx] : (loopUrl || introTracks[introTracks.length - 1]);
        idx++;

        const startTrack = () => {
          if (!state.adActive || state.storeClosed) return; // 차임 재생중 광고 끝났을 수 있으니 재확인
          const a = new Audio(blobCache[url] || url);
          a.volume = 0;
          a.play().catch(() => {});
          state.fillerAudio = a;
          state.lastAudioAt = Date.now(); // 프로모 스케줄과 최소 간격 공유
          fadeTo(a, 1, cfg.muteDuringAd.fadeMs);
          a.addEventListener('ended', playNext); // 광고가 계속되면 다음 트랙으로 이어서
        };

        if (isIntro) {
          playChime().then(startTrack); // promo1·promo2 앞에만 띵동
        } else {
          startTrack(); // 필러 루프 구간은 차임 없이 바로 이어붙임
        }
      }
    }

    function stopFiller(fadeMs, onDone) {
      if (!state.fillerAudio) { onDone?.(); return; }
      const a = state.fillerAudio;
      state.fillerAudio = null;
      fadeTo(a, 0, fadeMs, () => { a.pause(); onDone?.(); });
    }

    // ━━━ 2. "계속 시청하시겠습니까" 팝업 자동 확인 (안전망) ━━━
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

    // ━━━ 3. 프로모 방송 — 고정 시계가 아니라 "마지막 방송 후 경과시간" 기준 ━━━
    // 광고 필러가 최근에 나갔으면 자동으로 뒤로 밀림 (광고 빈도를 몰라도 최소 간격 보장)
    if (cfg.audio?.enabled) {
      let idx = 0;
      const gapMs = cfg.audio.intervalMin * 60 * 1000;
      setInterval(() => {
        if (state.adActive) return;
        if (state.storeClosed) return; // 마감30분전~다음날오픈 전: 프로모 정지
        if (Date.now() - state.lastAudioAt < gapMs) return;
        const track = cfg.audio.tracks[idx % cfg.audio.tracks.length];
        idx++;
        playOneShot(track, cfg.audio.volume);
      }, 30000); // 30초마다 조건 체크 (실제 재생은 gapMs 조건 만족할 때만)
    }

    // ━━━ 4. 마감 방송(30/15/5/2분 전) + 영업시간 외 정지 ━━━
    // 마감30분전(offsetsMin 최댓값 기준) ~ 다음날 openTime 까지: 영상 pause + 프로모 정지
    checkClosing(cfg.closing); // 로드 직후 즉시 1회 판정 (30초 대기 없이 state.storeClosed 확정)
    setInterval(() => checkClosing(cfg.closing), 30000);

    // 테스트용 원샷 함수: localStorage 세팅 + 즉시 재판정 + 시각적 콘솔 확인까지 한 번에
    // unsafeWindow가 있으면(진짜 샌드박스) 그쪽에, 없으면(<script> 직접주입 등) window에 등록
    const globalTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    globalTarget.closeCheckNow = () => checkClosing(cfg.closing);

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

    // 진단용: 등록이 스크립트 자기 자신 관점에서 실제로 잡혔는지 즉시 확인
    console.log(
      '[Clore Core] 노출 진단 — unsafeWindow존재:', typeof unsafeWindow !== 'undefined',
      '| window===globalTarget:', window === globalTarget,
      '| typeof window.testClear:', typeof window.testClear
    );

    function checkClosing(closing) {
      const now = new Date();
      const target = getCloseTime(now, closing);
      const diffMin = (target - now) / 60000;
      closing.offsetsMin.forEach(min => {
        const key = `${now.toDateString()}_${min}`;
        if (Math.abs(diffMin - min) < 0.5 && !state.closedFlags[key]) {
          state.closedFlags[key] = true;
          const repeat = min === 30 ? 1 : 2; // 30분전은 17초라 충분히 김, 나머지는 두 번
          playClosingSet(`${closing.baseUrl}${min}m.mp3`, closing.volume, repeat);
        }
      });

      const closed = isInClosedWindow(now, closing);
      const video = document.querySelector('video');
      if (closed && !state.storeClosed) {
        if (state.adActive) return; // 광고 재생 중엔 건드리지 않음, 광고 끝난 뒤 다음 tick에 재시도
        state.storeClosed = true;
        video?.pause();
      } else if (!closed && state.storeClosed) {
        state.storeClosed = false;
        video?.play().catch(() => {});
      }
    }

    function isInClosedWindow(now, closing) {
      // 테스트용: 콘솔에서 testOpen() / testClosed() / testClear() 사용
      const override = localStorage.getItem('clore_test_closed');
      if (override === 'closed') return true;
      if (override === 'open') return false;

      const close = getCloseTime(now, closing);
      const pauseMin = Math.max(...closing.offsetsMin); // 30
      const pauseStart = new Date(close.getTime() - pauseMin * 60000);
      if (now >= pauseStart) return true; // 마감 30분 전 이후

      const [oh, om] = closing.openTime.split(':').map(Number);
      const todayOpen = new Date(now);
      todayOpen.setHours(oh, om, 0, 0);
      return now < todayOpen; // 오늘 아직 오픈 전
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
    console.log('[Clore Core] 테스트: testClosed() / testOpen() / testClear() 콘솔에서 바로 호출');
  }
})();
