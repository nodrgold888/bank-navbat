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
    const POLL_SLOW_MS = 10000; // SSE healthy — poll is just a safety net
    const POLL_TIMEOUT_MS = 8000; // a stalled poll must never stop the loop
    const SSE_STALE_MS = 35000; // no state/ping this long => the stream is silently dead, reopen it
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
    let es = null;
    let sseOpenedAt = 0;
    function openSSE() {
      if (stopped) return;
      if (es) {
        try {
          es.close();
        } catch (e) {
          /* already closed */
        }
        es = null;
      }
      try {
        es = new EventSource('/events');
      } catch (e) {
        return;
      }
      sseOpenedAt = Date.now();
      const mine = es;
      mine.addEventListener('state', function (e) {
        lastSseAt = Date.now();
        apply(e.data);
      });
      mine.addEventListener('ping', function () {
        lastSseAt = Date.now();
      });
      mine.addEventListener('error', function () {
        markMaybeOffline();
        if (mine.readyState === EventSource.CLOSED && es === mine) setTimeout(openSSE, 3000);
      });
    }
    openSSE();

    // A half-open connection (Wi-Fi drop, NAT/proxy timeout, a sleeping device) fires no
    // error and just goes quiet, so the stream is reopened if nothing — not even the
    // server's 15s ping — has arrived for SSE_STALE_MS.
    setInterval(function () {
      if (stopped) return;
      const quietFor = Date.now() - Math.max(lastSseAt, sseOpenedAt);
      if (quietFor > SSE_STALE_MS) openSSE();
    }, 5000);

    // --- Transport 2: adaptive polling backbone ---
    // Polls fast until SSE proves itself, then backs off to a slow safety net.
    // Keeps hundreds of concurrent clients cheap when SSE is healthy, while
    // still guaranteeing <=2.5s updates through proxies that buffer SSE.
    async function poll() {
      // No timeout here used to be fatal: one request hung on a dead connection
      // never settled, so loop() never ran again and the page froze for good.
      const controller = new AbortController();
      const timer = setTimeout(function () {
        controller.abort();
      }, POLL_TIMEOUT_MS);
      try {
        const r = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
        if (r.ok) apply(await r.text());
        else markMaybeOffline();
      } catch (e) {
        markMaybeOffline();
      } finally {
        clearTimeout(timer);
      }
    }

    let loopTimer = null;
    function loop() {
      if (stopped) return;
      clearTimeout(loopTimer);
      const sseHealthy = Date.now() - lastSseAt < SSE_HEALTHY_MS;
      loopTimer = setTimeout(
        function () {
          if (stopped) return;
          poll().then(loop, loop);
        },
        sseHealthy ? POLL_SLOW_MS : POLL_FAST_MS
      );
    }
    poll().then(loop, loop);

    // Coming back from sleep / a network drop / a hidden tab: refresh right away
    // instead of waiting for the next timer, and replace a possibly dead stream.
    function wake() {
      if (stopped) return;
      openSSE();
      poll().then(loop, loop);
    }
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) wake();
    });

    return {
      close: function () {
        stopped = true;
      },
    };
  }

  /** JSON POST so'rov. */
  const POST_TIMEOUT_MS = 8000;
  const POST_ATTEMPTS = 2;

  function newRequestId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function post(url, body) {
    // Every caller (kiosk ticket-taking, staff call/recall/skip/cancel,
    // admin cancel/reset) disables its buttons before this call and
    // re-enables them once it settles — without a timeout, a stalled
    // connection left those buttons disabled for minutes, with no error shown.
    //
    // A timeout does NOT mean the server didn't act: the request may well have been
    // processed with only the reply lost. So the same X-Request-Id is sent on every
    // attempt and the server runs a given id only once (replaying the saved answer),
    // which makes an automatic retry safe — and means a staff member never has to
    // re-click "call next" (which would skip a customer) after a flaky moment.
    const requestId = newRequestId();
    let lastErr = null;
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('Server javob bermadi') : e;
        if (attempt < POST_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(timer);
      }
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
    throw lastErr || new Error('Server javob bermadi');
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
  // The TV display gets no clicks/taps/keys at all — it's an unattended
  // screen — so those listeners above never fire there and every chime
  // attempt is silently blocked by the browser's autoplay policy (no user
  // gesture ever happened). Try unlocking right away too: harmless where a
  // real gesture will unlock it anyway, and it's the only chance this page
  // gets on a TV. (The browser still needs to be launched with
  // --autoplay-policy=no-user-gesture-required for this to actually work —
  // see print-service/tv-autostart.bat — this alone isn't a full fix.)
  unlockAudio();

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

  // --- Voice announcement (Web Speech API) ---------------------------------
  // There is no bundled voice audio here — this speaks through whatever
  // text-to-speech voice is installed on the device/browser. Quality and
  // even Uzbek availability depend entirely on that: Chrome typically only
  // ships a real "uz-UZ" voice when it can reach Google's online voice
  // service, and Windows' own built-in (offline) SAPI voices usually don't
  // include Uzbek at all. Because of that, the operator explicitly picks
  // a voice (persisted per device) rather than us silently guessing one —
  // picking the least-bad available voice is a per-machine judgment call.
  const TTS_VOICE_KEY = 'navbatTtsVoiceURI';
  const hasTTS = typeof window.speechSynthesis !== 'undefined';

  function listVoices() {
    if (!hasTTS) return [];
    return window.speechSynthesis.getVoices();
  }

  // Voice lists load asynchronously in most browsers — callback fires once
  // they're ready (immediately if already cached).
  function onVoicesReady(cb) {
    if (!hasTTS) return;
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) return cb(existing);
    window.speechSynthesis.addEventListener('voiceschanged', function once() {
      window.speechSynthesis.removeEventListener('voiceschanged', once);
      cb(window.speechSynthesis.getVoices());
    });
  }

  function getSelectedVoiceURI() {
    try {
      return localStorage.getItem(TTS_VOICE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setSelectedVoiceURI(uri) {
    try {
      localStorage.setItem(TTS_VOICE_KEY, uri || '');
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Speak text aloud using the operator-selected voice. No-ops quietly if
   * speech synthesis isn't supported or no voice has been chosen yet — the
   * chime alone still plays either way, so this is a pure enhancement.
   */
  function speak(text) {
    if (!hasTTS || !text) return;
    const uri = getSelectedVoiceURI();
    if (!uri) return; // nobody has picked a voice on this device yet
    const voice = listVoices().find(function (v) {
      return v.voiceURI === uri;
    });
    if (!voice) return; // previously-picked voice no longer available
    try {
      window.speechSynthesis.cancel(); // don't queue/overlap announcements
      const utter = new SpeechSynthesisUtterance(text);
      utter.voice = voice;
      utter.lang = voice.lang;
      utter.rate = 0.95;
      utter.pitch = 1;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      /* ignore */
    }
  }

  return {
    connect: connect,
    post: post,
    fmtClock: fmtClock,
    fmtDate: fmtDate,
    elapsed: elapsed,
    chime: chime,
    hasTTS: hasTTS,
    listVoices: listVoices,
    onVoicesReady: onVoicesReady,
    getSelectedVoiceURI: getSelectedVoiceURI,
    setSelectedVoiceURI: setSelectedVoiceURI,
    speak: speak,
  };
})();
