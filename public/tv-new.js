/* New TV queue board: big "now serving" hero + operator board + next-in-line strip. */
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };

  var soundOn = localStorage.getItem('tvSound') !== 'off';
  var lastSeq = null;
  var initialised = false;

  function updateSoundBtn() {
    $('soundToggle').textContent = soundOn ? '🔊 Signal' : '🔇 Signal';
  }
  updateSoundBtn();
  $('soundToggle').addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem('tvSound', soundOn ? 'on' : 'off');
    updateSoundBtn();
    if (soundOn) Navbat.chime();
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

  function announce(call) {
    if (soundOn) Navbat.chime(call.recall ? 'recall' : 'call');
    var f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
    var hero = $('hero');
    hero.classList.remove('pulse');
    void hero.offsetWidth;
    hero.classList.add('pulse');
    if (soundOn) {
      var prefix = call.recall ? 'Qayta chaqiruv. ' : '';
      Navbat.speak(prefix + call.code + ' raqamli mijoz, ' + call.operatorName + 'ga murojaat qiling.');
    }
  }

  function render(view) {
    var call = view.lastCall;

    // Hero: the most recent call, as long as that operator still holds it.
    var heroOk = false;
    if (call) {
      var row = view.board.find(function (b) {
        return b.id === call.operatorId;
      });
      heroOk = !!(row && row.ticketCode === call.code);
    }
    $('hero').classList.toggle('idle', !heroOk);
    if (heroOk) {
      $('heroCode').textContent = call.code;
      $('heroOp').textContent = call.operatorName;
      $('heroSvc').innerHTML = (call.serviceIcon ? esc(call.serviceIcon) + ' ' : '') + esc(call.serviceName);
    } else {
      $('heroCode').textContent = '—';
      $('heroOp').textContent = 'Navbatni kuting';
      $('heroSvc').textContent = '';
    }

    // Operator board (Valyuta first, as its own gold row)
    var online = view.board.filter(function (b) {
      return b.online;
    });
    var ordered = online
      .filter(function (b) {
        return b.name === 'Valyuta';
      })
      .concat(
        online.filter(function (b) {
          return b.name !== 'Valyuta';
        })
      );
    $('board').innerHTML = ordered
      .map(function (b) {
        var cls = 'row' + (b.name === 'Valyuta' ? ' vip' : '') + (b.ticketCode ? ' busy' : ' free');
        if (heroOk && call.operatorId === b.id) cls += ' latest';
        return (
          '<div class="' + cls + '"' +
          (b.ticketCode && b.serviceColor ? ' style="--c:' + esc(b.serviceColor) + '"' : '') +
          '><span class="dot"></span><span class="nm">' + esc(b.name) + '</span>' +
          '<span class="cd">' + (b.ticketCode ? esc(b.ticketCode) : 'bo‘sh') + '</span></div>'
        );
      })
      .join('');

    // Next in line
    var wl = view.waitingList || [];
    $('nextCount').textContent = wl.length + ' kishi kutmoqda';
    $('next').innerHTML = wl.length
      ? wl
          .map(function (w) {
            return (
              '<div class="chip" style="--c:' + esc(w.serviceColor || '#789') + '"><i></i><b>' +
              esc(w.code) + '</b><span>' + esc(w.serviceName) + '</span></div>'
            );
          })
          .join('')
      : '<div class="none">✓ Hozircha navbatda hech kim yo‘q</div>';

    if (call) {
      if (initialised && call.seq !== lastSeq) announce(call);
      lastSeq = call.seq;
    }
    initialised = true;
  }

  Navbat.connect(render, function (online) {
    $('offline').classList.toggle('show', !online);
    $('liveDot').classList.toggle('off', !online);
  });
})();
