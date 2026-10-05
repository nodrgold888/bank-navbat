/* Recorded Uzbek announcements. One complete customer call plays at a time. */
(function () {
  'use strict';
  var ctx, currentSource, cancelSpeech;
  var buffers = new Map();
  var queue = [];
  var running = false;
  var lastProgressAt = 0;
  var generation = 0;
  var enabled = true;
  var mode = 'voice'; // 'voice' = spoken call, 'ringtone' = the original bell only
  var naturalEnabled = false;
  var report = function () {};
  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }
  function tokens(call) {
    var code = String(call.code || '').toUpperCase();
    var operator = Number(call.operatorId);
    if (!/^[A-G]\d{3,}$/.test(code) || !Number.isInteger(operator) || operator < 1 || operator > 7) {
      throw new Error('Chaqiruv raqami noto‘g‘ri');
    }
    return (call.recall ? ['recall'] : ['attention'])
      .concat(code.split(''), ['customer'], operator === 7 ? ['7', 'operator-word'] : ['operator-' + operator], ['proceed']);
  }
  // Every clip stays cached once decoded; nothing is evicted or limited.
  function touch(key) {
    return buffers.get(key);
  }
  function load(key) {
    if (!buffers.has(key)) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      var promise = fetch(key === 'ringtone' ? '/audio/ringtone.mp3' : '/audio/voice/' + key + '.wav', { signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error('Audio topilmadi: ' + key); return r.arrayBuffer(); })
        .then(function (bytes) { return context().decodeAudioData(bytes); })
        .catch(function (err) { buffers.delete(key); throw err; })
        .finally(function () { clearTimeout(timeout); });
      buffers.set(key, promise);
    }
    return touch(key);
  }
  function play(buffer) {
    return new Promise(function (resolve) {
      var source = context().createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      currentSource = source;
      var finished = false;
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        try { source.disconnect(); } catch (e) {}
        if (currentSource === source) currentSource = null;
        resolve();
      }
      // 'ended' never fires if the audio context is suspended mid-clip (TV sleep, lost audio
      // focus). Waiting for it forever used to wedge the whole voice queue until a reload.
      var guard = setTimeout(function () { try { source.stop(); } catch (e) {} done(); }, (buffer.duration || 3) * 1000 + 1500);
      source.onended = done;
      lastProgressAt = Date.now();
      source.start();
    });
  }
  // The whole call is one sentence from the server's natural voice; the server prepares it
  // when the ticket is issued, so it is normally cached by the time an operator calls.
  function natural(call) {
    var key = 'natural:' + (call.recall ? '1:' : '0:') + call.code + ':' + call.operatorId;
    if (!buffers.has(key)) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 15000);
      var url = '/api/tts?code=' + encodeURIComponent(call.code) +
        '&operator=' + encodeURIComponent(call.operatorId) + (call.recall ? '&recall=1' : '');
      var promise = fetch(url, { signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error('Tabiiy ovoz ishlamadi'); return r.arrayBuffer(); })
        .then(function (bytes) { return context().decodeAudioData(bytes); })
        .catch(function (err) { buffers.delete(key); throw err; })
        .finally(function () { clearTimeout(timeout); });
      buffers.set(key, promise);
    }
    var p = buffers.get(key);
    p.then(function () { buffers.delete(key); }, function () {}); // one-off audio; keep memory flat
    return p;
  }

  // Mira recordings (public/audio/mira): whole phrases, so a call is 3-4 natural pieces:
  // letter, number ("yigirma uch raqamli mijoz."), operator ("oltinchi aperatorga murojaat qiling.").
  // Numbers 100-999 add a hundreds piece. Returns null when a call can't be built from them.
  function phrasePlan(call) {
    var code = String(call.code || '').toUpperCase();
    var m = /^([A-G])(\d{3,})$/.exec(code);
    var operator = Number(call.operatorId);
    if (!m || !Number.isInteger(operator) || operator < 1 || operator > 7) return null;
    var n = Number(m[2]);
    if (n < 1 || n > 999) return null;
    var plan = call.recall ? [['recall', 0.25]] : [];
    plan.push(['l-' + m[1], 0.03]);
    var hundreds = Math.floor(n / 100), rest = n % 100;
    if (hundreds && !rest) plan.push(['ht-' + hundreds, 0.1]);
    else {
      if (hundreds) plan.push(['h-' + hundreds, 0.03]);
      plan.push(['n-' + rest, 0.1]);
    }
    plan.push(['op-' + operator, 0]);
    return plan;
  }
  function loadPhrase(key) {
    var k = 'phrase:' + key;
    if (!buffers.has(k)) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      var promise = fetch('/audio/mira/' + key + '.mp3', { signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error('Audio topilmadi: ' + key); return r.arrayBuffer(); })
        .then(function (bytes) { return context().decodeAudioData(bytes); })
        .catch(function (err) { buffers.delete(k); throw err; })
        .finally(function () { clearTimeout(timeout); });
      buffers.set(k, promise);
    }
    return touch(k);
  }
  function pause(seconds) {
    return new Promise(function (resolve) { setTimeout(resolve, seconds * 1000); });
  }

  // F was not supplied. Only that letter uses speech synthesis until F.wav exists.
  async function missingF() {
    try { return await load('F'); } catch (_) { return null; }
  }
  function speakF() {
    return new Promise(function (resolve, reject) {
      if (!window.speechSynthesis) return reject(new Error('F harfi yozuvini qo‘shish kerak'));
      var utter = new SpeechSynthesisUtterance('Ef');
      var voices = window.speechSynthesis.getVoices();
      utter.voice = voices.find(function (v) { return /^uz/i.test(v.lang); }) || voices.find(function (v) { return /^en/i.test(v.lang); }) || null;
      utter.lang = utter.voice ? utter.voice.lang : 'uz-UZ';
      var timer = setTimeout(function () { window.speechSynthesis.cancel(); finish(new Error('F harfi ovozi ishlamadi')); }, 5000);
      function finish(error) { clearTimeout(timer); cancelSpeech = null; error ? reject(error) : resolve(); }
      cancelSpeech = function () { window.speechSynthesis.cancel(); finish(); };
      utter.onend = function () { finish(); };
      utter.onerror = function () { finish(new Error('F harfi yozuvini qo‘shish kerak')); };
      window.speechSynthesis.speak(utter);
    });
  }
  // Original bell (public/audio/ringtone.mp3): once for a call, twice for a recall.
  async function ring(call) {
    var bell = await load('ringtone');
    await play(bell);
    if (call.recall) { await pause(0.3); await play(bell); }
  }
  async function drain() {
    // Only a queue that has made NO progress for a minute counts as wedged; a long queue of
    // calls that is steadily playing is never interrupted.
    if (running && Date.now() - lastProgressAt > 60000) { running = false; generation++; }
    if (running || !enabled || !queue.length) return;
    running = true;
    lastProgressAt = Date.now();
    var version = generation;
    try {
      if (context().state !== 'running') {
        // resume() can stay pending until a user gesture; don't let that hold the queue.
        await Promise.race([ctx.resume(), pause(2.5)]);
      }
      if (ctx.state !== 'running') throw new Error('Ovozni yoqish uchun “Sinash” tugmasini bosing');
      while (queue.length && enabled && version === generation) {
        var call = queue.shift();
        lastProgressAt = Date.now();
        try {
          if (mode === 'ringtone') {
            await ring(call);
            continue;
          }
          if (naturalEnabled) {
            try {
              await play(await natural(call));
              continue;
            } catch (_) {
              // Keep the TV useful during an API/network outage by using local recordings.
            }
          }
          var plan = phrasePlan(call);
          var phrases = plan && await Promise.all(plan.map(function (step) { return loadPhrase(step[0]); })).catch(function () { return null; });
          if (phrases) {
            for (var j = 0; j < plan.length && enabled && version === generation; j++) {
              await play(phrases[j]);
              if (plan[j][1]) await pause(plan[j][1]);
            }
            continue;
          }
          // Older recordings cover anything the Lola set can't (e.g. a missing number clip).
          var parts = tokens(call);
          var audio = await Promise.all(parts.map(function (key) { return key === 'F' ? missingF() : load(key); }));
          for (var i = 0; i < parts.length && enabled && version === generation; i++) {
            if (audio[i]) await play(audio[i]); else await speakF();
          }
        } catch (error) { report(error.message); }
      }
    } catch (error) { report(error.message); }
    finally {
      running = false;
      if (queue.length && enabled && ctx && ctx.state === 'running') drain();
    }
  }
  window.TVVoice = {
    tokens: tokens,
    enqueue: function (call) { if (enabled) { queue.push(call); drain(); } },
    onError: function (cb) { report = cb; },
    unlock: function () { try { context().resume().then(drain).catch(function () { report('Ovozni yoqish uchun “Sinash” tugmasini bosing'); }); } catch (e) { report(e.message); } },
    setNaturalEnabled: function (value) { naturalEnabled = !!value; },
    setMode: function (value) { mode = value === 'ringtone' ? 'ringtone' : 'voice'; },
    getMode: function () { return mode; },
    isIdle: function () { return !running && !queue.length; },
    setEnabled: function (value) {
      enabled = value;
      if (!value) { generation++; queue.length = 0; if (currentSource) currentSource.stop(); if (cancelSpeech) cancelSpeech(); }
    }
  };
  document.addEventListener('pointerdown', window.TVVoice.unlock, { passive: true });
})();
