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
  function announce(call) {
    if (soundOn) Navbat.chime(call.recall ? 'recall' : 'call');
    var hl = $('headline');
    hl.classList.remove('flash');
    void hl.offsetWidth;
    hl.classList.add('flash');
  }

  // ---- Render ----
  function render(view) {
    var call = view.lastCall;
    if (call) {
      var opName = call.operatorName || call.operatorId + '-operator';
      $('hlCode').textContent = call.code;
      $('hlOp').textContent = opName.toUpperCase();
      $('hlGoto').textContent =
        (call.serviceIcon ? call.serviceIcon + ' ' : '') +
        call.serviceName +
        ' — Iltimos, ' +
        opName +
        'ga murojaat qiling';
      $('hlNote').textContent = call.recall ? 'Qayta chaqirilmoqda' : '';
    } else {
      $('hlCode').textContent = '—';
      $('hlOp').textContent = '—';
      $('hlGoto').textContent = 'Navbat kutilmoqda';
      $('hlNote').textContent = '';
    }

    // Operator grid (6)
    var grid = $('opGrid');
    grid.innerHTML = '';
    view.board.forEach(function (b) {
      var cell = document.createElement('div');
      cell.className = 'op-cell';
      if (!b.online) cell.classList.add('paused');
      else if (!b.ticketCode) cell.classList.add('idle');
      if (call && call.operatorId === b.id && b.ticketCode === call.code) {
        cell.classList.add('just-called');
      }

      var statusTxt = !b.online ? 'dam olishda' : b.ticketCode ? '' : 'boʻsh';
      var svcHtml = b.ticketCode
        ? '<span class="dot" style="background:' +
          (b.serviceColor || '#789') +
          '"></span>' +
          (b.serviceIcon ? b.serviceIcon + ' ' : '') +
          (b.serviceName || '')
        : '';
      cell.innerHTML =
        '<div class="op-name">' +
        b.name +
        ' <small>' +
        statusTxt +
        '</small></div>' +
        '<div class="op-code">' +
        (b.ticketCode || '—') +
        '</div>' +
        '<div class="op-svc">' +
        svcHtml +
        '</div>';
      grid.appendChild(cell);
    });

    // Waiting list (next up to 8, across all queues)
    var wl = $('waitingList');
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

    // Legend (service colors)
    var lg = $('legend');
    lg.innerHTML = '';
    view.services.forEach(function (s) {
      var span = document.createElement('span');
      span.innerHTML =
        '<i style="background:' + s.color + '"></i>' + s.icon + ' ' + s.name;
      lg.appendChild(span);
    });

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
  }

  Navbat.connect(render, onConn);
})();
