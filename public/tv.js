/* ==========================================================================
   TV display (read-only, auto-updating)
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var soundOn = localStorage.getItem('tvSound') !== 'off';
  var lastSeq = null;
  var initialised = false;
  var lastWaitingSig = null;

  // ---- Auto-scroll the waiting-queue panel ----
  // Every waiting ticket is sent now (no more 8-item cutoff), so the list
  // can be taller than the panel. This is an unattended display — nobody's
  // going to scroll it by hand — so cycle through it automatically instead
  // of just clipping whatever doesn't fit.
  var waitingScrollTimer = null;
  var waitingScrollPaused = false;
  function manageWaitingScroll(el) {
    var overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 4) {
      if (waitingScrollTimer) {
        clearInterval(waitingScrollTimer);
        waitingScrollTimer = null;
      }
      el.scrollTop = 0;
      return;
    }
    if (waitingScrollTimer) return; // already cycling
    waitingScrollTimer = setInterval(function () {
      if (waitingScrollPaused) return;
      var max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max) {
        waitingScrollPaused = true;
        setTimeout(function () {
          el.scrollTop = 0;
          waitingScrollPaused = false;
        }, 2500);
        return;
      }
      el.scrollTop += 1;
    }, 40);
  }

  updateSoundBtn();
  $('soundToggle').addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem('tvSound', soundOn ? 'on' : 'off');
    updateSoundBtn();
    if (soundOn) Navbat.chime(); // user gesture — unlocks WebAudio
  });
  function updateSoundBtn() {
    $('soundToggle').textContent = soundOn ? '🔊 Signal: yoniq' : '🔇 Signal: oʻchiq';
  }

  // Test button — plays the call signal
  $('soundTest').addEventListener('click', function () {
    Navbat.chime('call');
  });

  // ---- Voice announcement setup ----
  // No voice is bundled or auto-picked: quality varies wildly by device
  // (Chrome only offers a real Uzbek voice when it can reach Google's
  // online voice list; Windows' own offline voices usually have none at
  // all), so whoever sets up this TV picks whichever installed voice
  // actually sounds acceptable, once, and it's remembered on this device.
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
    voiceSelect.title = 'Bu brauzer ovozda oʻoqishni qoʻllab-quvvatlamaydi';
  }
  voiceSelect.addEventListener('change', function () {
    Navbat.setSelectedVoiceURI(voiceSelect.value);
  });
  $('voiceTest').addEventListener('click', function () {
    if (!voiceSelect.value) {
      voiceToast("Avval ro'yxatdan ovoz tanlang");
      return;
    }
    Navbat.speak('B001 raqamli mijoz, 6-operatorga murojaat qiling.');
  });
  var voiceToastTimer = null;
  function voiceToast(msg) {
    var el = $('voiceToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(voiceToastTimer);
    voiceToastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2200);
  }

  // ---- Clock ----
  function tickClock() {
    var d = new Date();
    $('clock').textContent = Navbat.fmtClock(d);
    $('date').textContent = Navbat.fmtDate(d);
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ---- Announcement ----
  // The headline banner that used to show this text is gone (operators now
  // get more screen space) — the full-screen boom flash plus each operator
  // box's own highlight/pulse (see render() below) carry the announcement.
  function announce(call) {
    if (soundOn) Navbat.chime(call.recall ? 'recall' : 'call');
    var boom = $('tvBoom');
    boom.classList.remove('boom');
    void boom.offsetWidth;
    boom.classList.add('boom');
    if (soundOn) {
      var prefix = call.recall ? 'Qayta chaqiruv. ' : '';
      Navbat.speak(prefix + call.code + ' raqamli mijoz, ' + call.operatorName + 'ga murojaat qiling.');
    }
  }

  // ---- Render ----
  var lastView = null;
  function render(view) {
    lastView = view;
    var call = view.lastCall;

    // Shared markup builder for both the regular grid cells and the
    // featured Valyuta box below. Service type is intentionally left off —
    // just the operator and the ticket number, sized to fill the space that
    // used to go to the service line.
    function opCellHtml(b) {
      var statusTxt = b.ticketCode ? '' : 'boʻsh';
      return (
        '<div class="op-name">' +
        '<span class="op-name-text">' + b.name + '</span>' +
        (statusTxt ? '<small>' + statusTxt + '</small>' : '') +
        '</div>' +
        '<div class="op-code">' +
        (b.ticketCode || '—') +
        '</div>'
      );
    }

    // Valyuta gets its own featured, centered box instead of sitting in the
    // regular grid — pulled out here, before the grid loop below.
    var onlineBoard = view.board.filter(function (b) {
      return b.online;
    });
    var valyutaWrap = $('valyutaWrap');
    valyutaWrap.innerHTML = '';
    var valyuta = onlineBoard.find(function (b) {
      return b.name === 'Valyuta';
    });
    if (valyuta) {
      var vCell = document.createElement('div');
      vCell.className = 'op-cell valyuta-cell';
      if (!valyuta.ticketCode) vCell.classList.add('idle');
      var vJustCalled = call && call.operatorId === valyuta.id && valyuta.ticketCode === call.code;
      if (vJustCalled) vCell.classList.add('just-called');
      vCell.innerHTML = opCellHtml(valyuta);
      valyutaWrap.appendChild(vCell);
    }

    // Operators split in two: busy ones get a full-width emphasized row
    // (easy to scan top-to-bottom, "CODE → operator" reads like a real
    // branch board), idle ones get compact tiles below since there's
    // nothing urgent to show for them. Paused/offline operators are left
    // off the board entirely (a customer has nowhere to go for one anyway).
    var allOperators = onlineBoard.filter(function (b) {
      return b.name !== 'Valyuta';
    });
    var busyOperators = allOperators.filter(function (b) {
      return b.ticketCode;
    });
    var idleOperators = allOperators.filter(function (b) {
      return !b.ticketCode;
    });

    var busyList = $('opBusyList');
    busyList.innerHTML = '';
    busyOperators.forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'op-row';
      var justCalled = call && call.operatorId === b.id && b.ticketCode === call.code;
      if (justCalled) row.classList.add('just-called');
      var accent = b.serviceColor || '#6fe6a0';
      row.style.borderColor = accent;
      row.style.background = 'linear-gradient(120deg, ' + accent + '2e 0%, ' + accent + '10 100%)';
      var svcHtml = (b.serviceIcon ? b.serviceIcon + ' ' : '') + (b.serviceName || '');
      row.innerHTML =
        '<div class="op-row-label">' + b.name + '</div>' +
        '<div class="op-row-main">' +
        '<span class="op-row-code">' + b.ticketCode + '</span>' +
        '<span class="op-row-arrow">→</span>' +
        '<span class="op-row-dest">' + b.name + '</span>' +
        '</div>' +
        '<div class="op-row-sub">' + svcHtml + '</div>';
      busyList.appendChild(row);
    });

    var grid = $('opGrid');
    grid.innerHTML = '';
    // Compact idle tiles: a plain grid of same-size boxes, sized to fit the
    // space left after the busy rows above — no need to be square here,
    // they just need to be readable and not take more room than they must.
    var n = idleOperators.length || 1;
    // Keep idle tiles on a single row whenever reasonable — wrapping to a
    // second row risks it getting clipped under the busy rows above on
    // shorter screens, and a wide single row reads fine either way.
    var cols = n <= 6 ? n : Math.ceil(Math.sqrt(n) * 1.4);
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    grid.style.gridAutoRows = 'minmax(70px, 1fr)';
    idleOperators
      .forEach(function (b) {
        var cell = document.createElement('div');
        cell.className = 'op-cell idle';
        cell.innerHTML = opCellHtml(b);
        grid.appendChild(cell);
      });

    // Waiting list — every queue, not just the first few. Only rebuild the
    // DOM when the actual set of waiting tickets changes, so an in-progress
    // auto-scroll (below) isn't reset to the top on every routine state push.
    var wl = $('waitingList');
    var waitingSig = view.waitingList.map(function (w) {
      return w.code;
    }).join(',');
    if (waitingSig !== lastWaitingSig) {
      lastWaitingSig = waitingSig;
      wl.innerHTML = '';
      if (!view.waitingList.length) {
        var e = document.createElement('div');
        e.className = 'wait-empty';
        e.textContent = 'Hozircha navbatda hech kim yoʻq';
        wl.appendChild(e);
      } else {
        view.waitingList.forEach(function (w) {
          var item = document.createElement('div');
          item.className = 'wait-item';
          item.innerHTML =
            '<span class="dot" style="background:' +
            (w.serviceColor || '#789') +
            '"></span>' +
            '<span class="wi-code tabnum">' +
            w.code +
            '</span><span class="wi-svc">' +
            (w.serviceIcon ? w.serviceIcon + ' ' : '') +
            w.serviceName +
            '</span>';
          wl.appendChild(item);
        });
      }
    }
    manageWaitingScroll(wl);

    // Detect a fresh call
    if (call) {
      if (initialised && call.seq !== lastSeq) announce(call);
      lastSeq = call.seq;
    }
    initialised = true;
  }

  function onConn(online) {
    $('offline').classList.toggle('show', !online);
    $('liveDot').classList.toggle('live-dot-off', !online);
  }

  Navbat.connect(render, onConn);

  // Cell size is computed in pixels from available space (see render()), so
  // it needs recomputing whenever the window/screen size actually changes.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (lastView) render(lastView);
    }, 150);
  });
})();
