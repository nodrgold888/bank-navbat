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

    // Shared markup builder for every operator cell, Valyuta included —
    // every operator gets the same amount of space, no one gets a bigger
    // or smaller box than anyone else. Service type is intentionally left
    // off — just the operator and the ticket number.
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

    // Every online operator (Valyuta included) sits in one equal-size grid
    // — paused/offline operators are left off the board entirely (a
    // customer has nowhere to go for one anyway).
    var onlineBoard = view.board.filter(function (b) {
      return b.online;
    });
    var grid = $('opGrid');
    grid.innerHTML = '';
    // Pick a column/row count that keeps the grid close to square, then size
    // each cell in actual pixels so every box is the same true size —
    // computed from the space really available, so it still fits without
    // clipping instead of overflowing off-screen.
    var n = onlineBoard.length || 1;
    var cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    var rows = Math.max(1, Math.ceil(n / cols));
    var gap = 20;
    var availW = grid.clientWidth;
    var availH = grid.clientHeight;
    var cellW = Math.floor((availW - gap * (cols - 1)) / cols);
    var cellH = Math.floor((availH - gap * (rows - 1)) / rows);
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', ' + cellW + 'px)';
    grid.style.gridAutoRows = cellH + 'px';
    grid.style.setProperty('--op-cell-size', Math.min(cellW, cellH) + 'px');
    onlineBoard.forEach(function (b) {
      var cell = document.createElement('div');
      cell.className = 'op-cell';
      if (!b.ticketCode) cell.classList.add('idle');
      var justCalled = call && call.operatorId === b.id && b.ticketCode === call.code;
      if (justCalled) cell.classList.add('just-called');
      // Border (and its glow) picks up the active service's own color, so
      // busy boxes are easy to tell apart at a glance.
      if (b.ticketCode && !justCalled) {
        var glowColor = b.serviceColor || '#eab308';
        cell.style.borderColor = glowColor;
        cell.style.boxShadow = '0 0 18px ' + glowColor + '80, inset 0 0 24px ' + glowColor + '22';
      }
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
