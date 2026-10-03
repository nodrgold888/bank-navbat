/* Recorded Uzbek announcements. One complete customer call plays at a time. */
(function () {
  'use strict';
  var ctx, currentSource, cancelSpeech;
  var buffers = new Map();
  var queue = [];
  var running = false;
  var generation = 0;
  var enabled = true;
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
  function load(key) {
    if (!buffers.has(key)) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      var promise = fetch('/audio/voice/' + key + '.wav', { signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error('Audio topilmadi: ' + key); return r.arrayBuffer(); })
        .then(function (bytes) { return context().decodeAudioData(bytes); })
        .catch(function (err) { buffers.delete(key); throw err; })
        .finally(function () { clearTimeout(timeout); });
      buffers.set(key, promise);
    }
    return buffers.get(key);
  }
  function play(buffer) {
    return new Promise(function (resolve) {
      var source = context().createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      currentSource = source;
      source.onended = function () { source.disconnect(); if (currentSource === source) currentSource = null; resolve(); };
      source.start();
    });
  }
  // The server serves the announcement as two cached pieces (ticket, operator) that are
  // already prepared by the time an operator presses "call"; they play back to back.
  function naturalPart(key, query) {
    if (!buffers.has(key)) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 15000);
      var promise = fetch('/api/tts?' + query, { signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error('Tabiiy ovoz ishlamadi'); return r.arrayBuffer(); })
        .then(function (bytes) { return context().decodeAudioData(bytes); })
        .catch(function (err) { buffers.delete(key); throw err; })
        .finally(function () { clearTimeout(timeout); });
      buffers.set(key, promise);
    }
    return buffers.get(key);
  }
  function natural(call) {
    var recall = call.recall ? '&recall=1' : '';
    var ticketKey = 'natural:ticket:' + (call.recall ? '1:' : '0:') + call.code;
    return Promise.all([
      naturalPart(ticketKey, 'part=ticket&code=' + encodeURIComponent(call.code) + recall),
      naturalPart('natural:operator:' + call.operatorId, 'part=operator&operator=' + encodeURIComponent(call.operatorId))
    ]).then(function (parts) {
      buffers.delete(ticketKey); // per-ticket audio is not reused; keep memory flat on a long-running TV
      return parts;
    });
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
  async function drain() {
    if (running || !enabled || !queue.length) return;
    running = true;
    var version = generation;
    try {
      if (context().state !== 'running') await ctx.resume();
      if (ctx.state !== 'running') throw new Error('Ovozni yoqish uchun “Sinash” tugmasini bosing');
      while (queue.length && enabled && version === generation) {
        var call = queue.shift();
        try {
          if (naturalEnabled) {
            try {
              var pieces = await natural(call);
              await play(pieces[0]);
              await play(pieces[1]);
              continue;
            } catch (_) {
              // Keep the TV useful during an API/network outage by using local recordings.
            }
          }
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
    setEnabled: function (value) {
      enabled = value;
      if (!value) { generation++; queue.length = 0; if (currentSource) currentSource.stop(); if (cancelSpeech) cancelSpeech(); }
    }
  };
  document.addEventListener('pointerdown', window.TVVoice.unlock, { passive: true });
})();
