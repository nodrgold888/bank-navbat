/* ==========================================================================
   Customer kiosk (mobile-first, opened via QR)
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var screenSelect = $('screen-select');
  var screenTicket = $('screen-ticket');
  var cardsBox = $('serviceCards');

  var lastView = null;
  var myTicket = null; // { code, serviceId, serviceName, serviceIcon, serviceColor }

  // ---- Auto-return to the main menu after a ticket is issued ----
  var AUTO_RETURN_MS = 5000;
  var autoReturnTimer = null;

  function clearAutoReturn() {
    if (autoReturnTimer) {
      clearTimeout(autoReturnTimer);
      autoReturnTimer = null;
    }
  }

  function scheduleAutoReturn() {
    clearAutoReturn();
    autoReturnTimer = setTimeout(backToSelect, AUTO_RETURN_MS);
  }

  // ---- Local receipt printer (print-service running on this kiosk PC) ----
  var PRINT_SERVICE_URL = 'http://localhost:9100/print';

  function printTicket(ticket, peopleAhead) {
    var now = new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    var payload = {
      service: ticket.serviceName,
      number: ticket.code,
      ahead: peopleAhead,
      date: p(now.getDate()) + '.' + p(now.getMonth() + 1) + '.' + now.getFullYear(),
      time: p(now.getHours()) + ':' + p(now.getMinutes()),
    };
    fetch(PRINT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function (err) {
      console.warn('Chek chop etilmadi (print-servis ishlamayapti?):', err.message);
    });
  }

  // ---- Clock ----
  function tickClock() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    $('clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes());
  }
  setInterval(tickClock, 15000);
  tickClock();

  // ---- Service cards ----
  function renderCards(view) {
    if (!view) return;
    if (cardsBox.children.length !== view.services.length) {
      cardsBox.innerHTML = '';
      view.services.forEach(function (s) {
        var btn = document.createElement('button');
        btn.className = 'svc-card';
        btn.style.setProperty('--c', s.color);
        btn.dataset.id = s.id;
        btn.innerHTML =
          '<span class="svc-ic">' +
          s.icon +
          '</span>' +
          '<span class="svc-txt">' +
          '<span class="svc-title"></span>' +
          '<span class="svc-sub"></span>' +
          '</span>' +
          '<span class="svc-meta"></span>';
        btn.addEventListener('click', function () {
          takeTicket(s.id);
        });
        cardsBox.appendChild(btn);
      });
    }
    view.services.forEach(function (s) {
      var btn = cardsBox.querySelector('[data-id="' + s.id + '"]');
      if (!btn) return;
      btn.querySelector('.svc-title').textContent = s.name;
      btn.querySelector('.svc-sub').textContent = s.subtitle;
      var meta = btn.querySelector('.svc-meta');
      meta.textContent = s.waiting === 0 ? 'Navbat boʻsh' : 'Navbatda ' + s.waiting;
    });
  }

  // ---- Take a ticket ----
  async function takeTicket(serviceId) {
    var buttons = cardsBox.querySelectorAll('button');
    buttons.forEach(function (b) {
      b.disabled = true;
    });
    try {
      var res = await Navbat.post('/api/ticket', { serviceId: serviceId });
      var t = res.ticket;
      myTicket = {
        code: t.code,
        serviceId: t.serviceId,
        serviceName: t.serviceName,
        serviceIcon: t.serviceIcon,
        serviceColor: t.serviceColor,
      };
      showTicket(t.position, t.peopleAhead, null);
      printTicket(myTicket, t.peopleAhead);
      scheduleAutoReturn();
    } catch (err) {
      alert('Xatolik: ' + err.message);
    } finally {
      buttons.forEach(function (b) {
        b.disabled = false;
      });
    }
  }

  function showTicket(position, peopleAhead, calledOperator) {
    screenSelect.hidden = true;
    screenTicket.hidden = false;

    $('ticketCard').style.setProperty('--c', myTicket.serviceColor || '#1f6fd6');
    $('tSvcIcon').textContent = myTicket.serviceIcon || '•';
    $('tSvcName').textContent = myTicket.serviceName || '';
    $('tCode').textContent = myTicket.code;

    var calledBox = $('tCalled');
    var active = $('tActive');
    if (calledOperator) {
      calledBox.hidden = false;
      calledBox.textContent =
        myTicket.code + ' — Iltimos, ' + calledOperator + '-operatorga murojaat qiling';
      active.hidden = true;
    } else {
      calledBox.hidden = true;
      active.hidden = false;
      $('tPos').textContent = position + '-oʻrin';
      $('tAhead').textContent = peopleAhead;
      var svc = svcOf(lastView, myTicket.serviceId);
      $('tPeople').textContent =
        'Bu xizmatda navbatda kutayotganlar: ' + (svc ? svc.waiting : peopleAhead + 1);
    }
  }

  function backToSelect() {
    clearAutoReturn();
    myTicket = null;
    screenTicket.hidden = true;
    screenSelect.hidden = false;
    renderCards(lastView);
  }
  $('btnNew').addEventListener('click', backToSelect);

  function svcOf(view, id) {
    return view && (view.services || []).find(function (s) {
      return s.id === id;
    });
  }

  // ---- Live updates ----
  function onState(view) {
    lastView = view;

    if (screenTicket.hidden) {
      renderCards(view);
      return;
    }
    if (!myTicket) return;

    // Called by an operator?
    var calledRow = (view.board || []).find(function (b) {
      return b.ticketCode === myTicket.code;
    });
    if (calledRow) {
      showTicket(0, 0, calledRow.id);
      return;
    }

    // Still waiting — recompute position.
    var found = false;
    var ahead = 0;
    (view.waitingList || []).forEach(function (w) {
      if (w.code === myTicket.code) {
        found = true;
      } else if (!found && w.serviceId === myTicket.serviceId) {
        ahead += 1;
      }
    });
    var svc = svcOf(view, myTicket.serviceId);
    if (!found && svc) {
      // Number not in the short list (long queue) — approximate.
      ahead = Math.max(ahead, svc.waiting - 1);
    }
    if (ahead < 0) ahead = 0;
    showTicket(ahead + 1, ahead, null);
  }

  function onConn(online) {
    $('offline').classList.toggle('show', !online);
  }

  Navbat.connect(onState, onConn);
})();
