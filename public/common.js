/* ==========================================================================
   Bank navbat tizimi — umumiy mijoz kodi
   ========================================================================== */

window.Navbat = (function () {
  'use strict';

  /**
   * Subscribe to server state.
   *
   * Two transports run together:
   *   1. Server-Sent Events (/events) — sub-second updates on a LAN.
   *   2. A 2.5s poll of /api/state — the reliable backbone. Works through any
   *      proxy, tunnel or host (some, e.g. Cloudflare, buffer SSE bodies).
   *
   * Whichever delivers first wins; identical snapshots are ignored so there is
   * no redundant re-render or double chime.
   *
   * @param {(view: object) => void} onState
   * @param {(online: boolean) => void} [onConnChange]
   */
  function connect(onState, onConnChange) {
    let alive = null;
    let lastJson = '';
    let lastOkAt = 0;
    let lastSseAt = 0; // last time the SSE stream actually delivered something
    let stopped = false;

    const POLL_FAST_MS = 2500; // SSE dead / buffered — polling carries the load
    const POLL_SLOW_MS = 20000; // SSE healthy — poll is just a safety net
    const SSE_HEALTHY_MS = 26000; // no state/ping within this => treat SSE as down
    const OFFLINE_AFTER_MS = 7000;

    function setConn(v) {
      if (v !== alive) {
        alive = v;
        if (onConnChange) onConnChange(v);
      }
    }

    function apply(text) {
      lastOkAt = Date.now();
      setConn(true);
      if (text === lastJson) return;
      lastJson = text;
      try {
        onState(JSON.parse(text));
      } catch (err) {
        console.error('Holatni oʻqib boʻlmadi', err);
      }
    }

    function markMaybeOffline() {
      if (Date.now() - lastOkAt > OFFLINE_AFTER_MS) setConn(false);
    }

    // --- Transport 1: SSE (primary when it works) ---
    function openSSE() {
      let es;
      try {
        es = new EventSource('/events');
      } catch (e) {
        return;
      }
      es.addEventListener('state', function (e) {
        lastSseAt = Date.now();
        apply(e.data);
      });
      es.addEventListener('ping', function () {
        lastSseAt = Date.now();
      });
      es.addEventListener('error', function () {
        markMaybeOffline();
        if (es.readyState === EventSource.CLOSED) setTimeout(openSSE, 3000);
      });
    }
    openSSE();

    // --- Transport 2: adaptive polling backbone ---
    // Polls fast until SSE proves itself, then backs off to a slow safety net.
    // Keeps hundreds of concurrent clients cheap when SSE is healthy, while
    // still guaranteeing <=2.5s updates through proxies that buffer SSE.
    async function poll() {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        if (r.ok) apply(await r.text());
        else markMaybeOffline();
      } catch (e) {
        markMaybeOffline();
      }
    }

    function loop() {
      if (stopped) return;
      const sseHealthy = Date.now() - lastSseAt < SSE_HEALTHY_MS;
      setTimeout(
        function () {
          if (stopped) return;
          poll().then(loop);
        },
        sseHealthy ? POLL_SLOW_MS : POLL_FAST_MS
      );
    }
    poll().then(loop);

    return {
      close: function () {
        stopped = true;
      },
    };
  }

  /** JSON POST so'rov. */
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* ignore */
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'Soʻrovda xatolik');
    }
    return data;
  }

  const WEEKDAYS = [
    'Yakshanba',
    'Dushanba',
    'Seshanba',
    'Chorshanba',
    'Payshanba',
    'Juma',
    'Shanba',
  ];
  const MONTHS = [
    'yanvar',
    'fevral',
    'mart',
    'aprel',
    'may',
    'iyun',
    'iyul',
    'avgust',
    'sentabr',
    'oktabr',
    'noyabr',
    'dekabr',
  ];

  function fmtClock(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDate(d) {
    d = d || new Date();
    return (
      WEEKDAYS[d.getDay()] +
      ', ' +
      d.getDate() +
      '-' +
      MONTHS[d.getMonth()] +
      ' ' +
      d.getFullYear()
    );
  }

  function elapsed(sinceTs) {
    const s = Math.max(0, Math.floor((Date.now() - sinceTs) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // --- Notification sound ----------------------------------------------------
  // Plays /audio/notify.mp3. Falls back to a synthesised bell if the file
  // can't be loaded or played. Browsers block audio until the page has had a
  // real user gesture, so on an unattended TV the very first automatic call
  // (nobody touched the Signal/Sinash button yet) can silently fail — that's
  // the "sometimes works, sometimes doesn't" symptom. To make the unlock as
  // likely as possible, ANY click/tap/keypress anywhere on the page primes
  // both the audio element and the WebAudio context, not just the dedicated
  // buttons, and the context is re-resumed whenever the tab regains
  // visibility (some browsers suspend it while backgrounded).
  const NOTIFY_SRC = '/audio/notify.mp3';
  let notifyEl = null;
  function notifyAudio() {
    if (!notifyEl) {
      notifyEl = new Audio(NOTIFY_SRC);
      notifyEl.preload = 'auto';
    }
    return notifyEl;
  }

  function playFile(volume) {
    // A fresh clone per call, instead of reusing/resetting one shared
    // element: two chimes fired close together (e.g. two calls landing
    // within the same second, or the recall's own double-beep) used to
    // race on the shared element's pause()/currentTime reset, which can
    // throw and silently drop the second sound.
    try {
      const a = notifyAudio().cloneNode(true);
      a.volume = volume;
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
      return p;
    } catch (e) {
      return null;
    }
  }

  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = synthBell._ctx || (synthBell._ctx = new Ctx());
        if (ctx.state === 'suspended') ctx.resume();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const a = notifyAudio();
      a.volume = 0;
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(
          function () {
            a.pause();
            a.currentTime = 0;
            a.volume = 1;
          },
          function () {}
        );
      }
    } catch (e) {
      /* ignore */
    }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, unlockAudio, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) unlockAudio();
  });

  function synthBell(kind) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = synthBell._ctx || (synthBell._ctx = new Ctx());
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      const tone = function (freq, start, dur, level) {
        [1, 2, 3].forEach(function (h, i) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq * h;
          g.gain.setValueAtTime(0.0001, start);
          g.gain.exponentialRampToValueAtTime(level / (i + 1.4), start + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
          osc.connect(g).connect(master);
          osc.start(start);
          osc.stop(start + dur + 0.05);
        });
      };
      if (kind === 'recall') {
        tone(784, t, 0.5, 0.4);
        tone(784, t + 0.22, 0.5, 0.4);
        tone(1046, t + 0.44, 0.8, 0.4);
      } else {
        tone(659.25, t, 1.1, 0.42);
        tone(523.25, t + 0.42, 1.4, 0.42);
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Play a notification sound.
   * @param {'call'|'recall'|'ticket'} [kind]  defaults to 'call'
   */
  function chime(kind) {
    try {
      const vol = kind === 'ticket' ? 0.5 : 1;
      const p = playFile(vol);
      if (p && typeof p.then === 'function') {
        p.then(null, function () {
          synthBell(kind);
        });
      }
      // recall: play it twice so it clearly differs from a first call
      if (kind === 'recall') {
        setTimeout(function () {
          try {
            const b = notifyAudio().cloneNode(true);
            b.volume = 1;
            const bp = b.play();
            if (bp && bp.catch) bp.catch(function () {});
          } catch (e) {
            /* ignore */
          }
        }, 650);
      }
    } catch (e) {
      synthBell(kind);
    }
  }

  return {
    connect: connect,
    post: post,
    fmtClock: fmtClock,
    fmtDate: fmtDate,
    elapsed: elapsed,
    chime: chime,
  };
})();
