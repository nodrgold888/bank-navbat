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
  }

  // ---- Render ----
  function render(view) {
    var call = view.lastCall;

    // Shared markup builder for both the regular grid cells and the
    // featured Valyuta box below.
    function opCellHtml(b) {
      var statusTxt = b.ticketCode ? '' : 'boʻsh';
      var svcHtml = b.ticketCode
        ? '<span class="dot" style="background:' +
          (b.serviceColor || '#789') +
          '"></span>' +
          (b.serviceIcon ? b.serviceIcon + ' ' : '') +
          (b.serviceName || '')
        : '';
      return (
        '<div class="op-name">' +
        '<span class="op-name-text">' + b.name + '</span>' +
        (statusTxt ? '<small>' + statusTxt + '</small>' : '') +
        '</div>' +
        '<div class="op-code">' +
        (b.ticketCode || '—') +
        '</div>' +
        '<div class="op-svc">' +
        svcHtml +
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

    // Operator grid — paused/offline operators are left off the board
    // entirely (a customer has nowhere to go for one anyway), instead of
    // showing a dimmed "dam olishda" box that just takes up space.
    var grid = $('opGrid');
    grid.innerHTML = '';
    onlineBoard
      .filter(function (b) {
        return b.name !== 'Valyuta';
      })
      .forEach(function (b) {
        var cell = document.createElement('div');
        cell.className = 'op-cell';
        if (!b.ticketCode) cell.classList.add('idle');
        var justCalled = call && call.operatorId === b.id && b.ticketCode === call.code;
        if (justCalled) cell.classList.add('just-called');
        // Border picks up the active service's own color — same idea as
        // Valyuta's gold border, just driven by whichever service the
        // operator is actually serving right now.
        if (b.ticketCode && !justCalled) cell.style.borderColor = b.serviceColor || '#eab308';
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

    // Footer stats
    $('stIssued').textContent = view.stats.issued;
    $('stServed').textContent = view.stats.served;
    $('stWaiting').textContent = view.stats.waiting;
    $('stAvg').textContent = view.stats.avgServiceMin;

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
})();
