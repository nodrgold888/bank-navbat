/* TV display (read-only, auto-updating): a big "now serving" card per operator. */
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };

  var soundOn = localStorage.getItem('tvSound') !== 'off';
  var lastSeq = null;
  var initialised = false;
  TVVoice.setEnabled(soundOn);
  TVVoice.onError(voiceToast);

  function updateSoundBtn() {
    $('soundToggle').textContent = soundOn ? '🔊 Signal' : '🔇 Signal';
  }
  updateSoundBtn();
  $('soundToggle').addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem('tvSound', soundOn ? 'on' : 'off');
    updateSoundBtn();
    TVVoice.setEnabled(soundOn);
    if (soundOn) TVVoice.unlock();
  });

  $('soundTest').addEventListener('click', function () {
    soundOn = true;
    localStorage.setItem('tvSound', 'on');
    updateSoundBtn();
    TVVoice.setEnabled(true);
    TVVoice.unlock();
    TVVoice.enqueue({ code: 'D042', operatorId: 2 });
  });

  // Voice setup: nothing is bundled or auto-picked (voice quality varies by
  // device); whoever sets up the TV picks an installed voice once.
  var voiceSelect = $('voiceSelect');
  if (Navbat.hasTTS) {
    Navbat.onVoicesReady(function (voices) {
      var saved = Navbat.getSelectedVoiceURI();
      var sorted = voices.slice().sort(function (a, b) {
        var aUz = /^uz/i.test(a.lang) ? 0 : 1;
        var bUz = /^uz/i.test(b.lang) ? 0 : 1;
        if (aUz !== bUz) return aUz - bUz;
        return a.name.localeCompare(b.name);
      });
      voiceSelect.innerHTML = '<option value="">🗣️ Ovoz: tanlanmagan</option>';
      sorted.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = (/^uz/i.test(v.lang) ? '⭐ ' : '') + v.name + ' (' + v.lang + ')';
        if (v.voiceURI === saved) opt.selected = true;
        voiceSelect.appendChild(opt);
      });
    });
  } else {
    voiceSelect.disabled = true;
  }
  voiceSelect.addEventListener('change', function () {
    Navbat.setSelectedVoiceURI(voiceSelect.value);
  });
  var voiceToastTimer = null;
  function voiceToast(msg) {
    var el = $('voiceToast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(voiceToastTimer);
    voiceToastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2200);
  }
  $('voiceTest').addEventListener('click', function () {
    if (!voiceSelect.value) {
      voiceToast("Avval ro'yxatdan ovoz tanlang");
      return;
    }
    Navbat.speak('B001 raqamli mijoz, 6-operatorga murojaat qiling.');
  });

  function tickClock() {
    var d = new Date();
    $('clock').textContent = Navbat.fmtClock(d);
    $('date').textContent = Navbat.fmtDate(d);
  }
  setInterval(tickClock, 1000);
  tickClock();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- Spoken call ----
  // TVVoice queues calls, prefers the server's natural Uzbek voice, and automatically
  // falls back to the local recordings when the provider or network is unavailable.
  var ttsEnabled = false;

  function announce(call) {
    if (soundOn) TVVoice.enqueue(call);
    var f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  function cardHtml(b, latest) {
    var busy = !!b.ticketCode;
    var cls = 'card ' + (busy ? 'busy' : 'free') + (b.name === 'Valyuta' ? ' vip' : '') + (latest ? ' latest' : '');
    return (
      '<div class="' + cls + '" data-op="' + b.id + '">' +
      '<div class="c-label">' + (busy ? 'Chaqirilmoqda' : 'Bo‘sh') + '</div>' +
      '<div class="c-code">' + (busy ? esc(b.ticketCode) : '—') + '</div>' +
      '<div class="c-go"><span>➜</span><b>' + esc(b.name) + '</b></div>' +
      '<div class="c-svc">' + (busy ? (b.serviceIcon ? esc(b.serviceIcon) + ' ' : '') + esc(b.serviceName || '') : '&nbsp;') + '</div>' +
      '</div>'
    );
  }

  // Keyingilar: a ticker that glides sideways when the tickets don't fit; static otherwise.
  var lastNextSig = null;
  var loadedAssetVersion = null;
  function chipHtml(w) {
    return (
      '<div class="chip" style="--c:' + esc(w.serviceColor || '#789') + '"><b>' +
      esc(w.code) + '</b><span>' + esc(w.serviceName) + '</span></div>'
    );
  }
  function renderNext(wl) {
    var strip = $('next');
    if (!wl.length) {
      strip.innerHTML = '<div class="none">✓ Hozircha navbatda hech kim yo‘q</div>';
      return;
    }
    var html = wl.map(chipHtml).join('');
    strip.innerHTML = '<div class="next-track">' + html + '</div>';
    var track = strip.firstChild;
    if (track.scrollWidth > strip.clientWidth + 4) {
      track.innerHTML = html + html; // second copy makes the loop seamless
      track.classList.add('run');
      track.style.setProperty('--dur', Math.max(12, track.scrollWidth / 2 / 90) + 's'); // ~90px/s
    }
  }

  function render(view) {
    ttsEnabled = !!view.tts;
    TVVoice.setNaturalEnabled(ttsEnabled);
    // Unattended TV: when the server is redeployed (new asset version), reload to pick up the new page.
    if (view.assetVersion) {
      if (!loadedAssetVersion) loadedAssetVersion = view.assetVersion;
      else if (view.assetVersion !== loadedAssetVersion) {
        location.reload();
        return;
      }
    }

    var call = view.lastCall;
    var online = view.board.filter(function (b) {
      return b.online;
    });
    var valyuta = online.filter(function (b) {
      return b.name === 'Valyuta';
    })[0];
    var rest = online.filter(function (b) {
      return b.name !== 'Valyuta';
    });
    function isLatest(b) {
      return !!(call && call.operatorId === b.id && b.ticketCode === call.code);
    }

    $('vwrap').innerHTML = valyuta ? cardHtml(valyuta, isLatest(valyuta)) : '';
    var cols = rest.length <= 3 ? Math.max(rest.length, 1) : rest.length <= 6 ? 3 : 4;
    $('grid').style.setProperty('--cols', cols);
    $('grid').innerHTML = rest
      .map(function (b) {
        return cardHtml(b, isLatest(b));
      })
      .join('');

    var wl = view.waitingList || [];
    $('nextCount').textContent = wl.length + ' kishi kutmoqda';
    var nextSig = wl.map(function (w) { return w.code; }).join(',');
    if (nextSig !== lastNextSig) {
      lastNextSig = nextSig;
      renderNext(wl);
    }

    if (call) {
      if (initialised && call.seq !== lastSeq) {
        var calls = (view.recentCalls || []).filter(function (item) {
          return item.seq > (lastSeq || 0);
        });
        if (!calls.length) calls = [call];
        calls.forEach(announce);
        var el = document.querySelector('.card[data-op="' + call.operatorId + '"]');
        if (el) el.classList.add('pulse');
      }
      lastSeq = call.seq;
    } else lastSeq = null;
    initialised = true;
  }

  // /tv?debug=1 shows the screen size and browser at the bottom-left, for diagnosing odd TVs.
  if (/[?&]debug=1/.test(location.search)) {
    var dbg = document.createElement('div');
    dbg.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:999;background:rgba(0,0,0,.75);color:#fff;font:12px monospace;padding:4px 8px;border-radius:4px;max-width:60vw';
    dbg.textContent = window.innerWidth + 'x' + window.innerHeight + ' @' + window.devicePixelRatio + ' | ' + navigator.userAgent;
    document.body.appendChild(dbg);
  }

  Navbat.connect(render, function (online) {
    $('offline').classList.toggle('show', !online);
    $('liveDot').classList.toggle('off', !online);
  });
})();
