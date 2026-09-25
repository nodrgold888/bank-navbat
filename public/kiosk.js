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
  // Only makes sense on the shared physical kiosk terminal — it needs to
  // reset itself for the next customer. Someone who scanned the QR code on
  // their own phone should keep watching their live ticket status instead
  // of getting yanked back to the menu. Distinguished by a URL flag that
  // only the physical kiosk's Chrome shortcut passes (see kiosk.bat:
  // ".../kiosk?shared=1"); a plain "/kiosk" link (the QR poster) does not.
  //
  // The flag is also cached in localStorage the first time it's seen: some
  // domain-forwarding/proxy setups drop query strings on later navigations
  // (e.g. Chrome kiosk mode reloading, or a bookmarked/history URL missing
  // it), which would otherwise silently turn the shared kiosk back into
  // "personal phone" mode — no auto-return, no kiosk-scale layout — with no
  // visible error, just it "not going back."
  var IS_SHARED_KIOSK = (function () {
    if (new URLSearchParams(location.search).get('shared') === '1') {
      try {
        localStorage.setItem('kioskShared', '1');
      } catch (e) {
        /* private mode / storage disabled — flag just won't persist */
      }
      return true;
    }
    try {
      return localStorage.getItem('kioskShared') === '1';
    } catch (e) {
      return false;
    }
  })();
  var AUTO_RETURN_MS = 3000;
  var autoReturnDeadline = 0; // 0 = no return scheduled
  var autoReturnCheckTimer = null;

  // Same flag also gates the full-screen "album" layout in style.css. Sizing
  // that up purely from viewport width/orientation would misfire on a large
  // phone held sideways (iPhone Pro Max / many Samsung Galaxy models hit
  // ~926px landscape width, over a naive 900px breakpoint) — a personal
  // phone must never get the giant kiosk-scale cards.
  if (IS_SHARED_KIOSK) {
    document.body.classList.add('shared-kiosk');
  }

  function clearAutoReturn() {
    autoReturnDeadline = 0;
    if (autoReturnCheckTimer) {
      clearInterval(autoReturnCheckTimer);
      autoReturnCheckTimer = null;
    }
  }

  // A repeating check against a wall-clock deadline, rather than a single
  // setTimeout — immune to the timer being silently dropped, and self-heals
  // if the tab was ever backgrounded/throttled (checks again as soon as it's
  // visible, via the visibilitychange listener below) instead of depending
  // on a background timer firing on schedule.
  function scheduleAutoReturn() {
    if (!IS_SHARED_KIOSK) return;
    autoReturnDeadline = Date.now() + AUTO_RETURN_MS;
    if (autoReturnCheckTimer) return;
    autoReturnCheckTimer = setInterval(function () {
      if (autoReturnDeadline && Date.now() >= autoReturnDeadline) {
        backToSelect();
      }
    }, 250);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && autoReturnDeadline && Date.now() >= autoReturnDeadline) {
      backToSelect();
    }
  });

  // ---- Local receipt printer (print-service running on this kiosk PC) ----
  var PRINT_SERVICE_URL = 'http://localhost:9100/print';
  var PRINT_TIMEOUT_MS = 6000; // print-servisning o'zi 8s ichida javob beradi/bermaydi
  var PRINT_RETRY_DELAY_MS = 1500;

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
    }, 3200);
  }

  var lastPrintPayload = null; // qo'lda qayta chop etish uchun saqlanadi
  var btnReprint = $('btnReprint');

  function postPrint(payload) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, PRINT_TIMEOUT_MS);
    return fetch(PRINT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Bitta muvaffaqiyatsizlik ko'pincha vaqtinchalik (printer uyg'onmoqda,
  // tarmoq sekinlashuvi) — jimgina yo'qotib yubormasdan, bir marta qayta
  // urinamiz, keyin muvaffaqiyatsiz bo'lsa mijozga ko'rinadigan qilamiz.
  async function attemptPrint(payload) {
    try {
      await postPrint(payload);
      return true;
    } catch (err) {
      console.warn('Chek chop etilmadi (1-urinish):', err.message);
      await sleep(PRINT_RETRY_DELAY_MS);
      try {
        await postPrint(payload);
        return true;
      } catch (err2) {
        console.warn('Chek chop etilmadi (2-urinish):', err2.message);
        return false;
      }
    }
  }

  async function printTicket(ticket, peopleAhead, position, etaMin) {
    var now = new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    var payload = {
      service: ticket.serviceName,
      number: ticket.code,
      ahead: peopleAhead,
      position: position,
      etaMin: etaMin,
      date: p(now.getDate()) + '.' + p(now.getMonth() + 1) + '.' + now.getFullYear(),
      time: p(now.getHours()) + ':' + p(now.getMinutes()),
    };
    lastPrintPayload = payload;
    btnReprint.hidden = true;

    var ok = await attemptPrint(payload);
    if (!ok) {
      toast('Chek chop etilmadi — printerni tekshiring');
      btnReprint.hidden = false;
    }
  }

  btnReprint.addEventListener('click', async function () {
    if (!lastPrintPayload) return;
    btnReprint.disabled = true;
    var ok = await attemptPrint(lastPrintPayload);
    btnReprint.disabled = false;
    if (ok) {
      toast('Chek chop etildi');
      btnReprint.hidden = true;
    } else {
      toast('Chek chop etilmadi — printerni tekshiring');
    }
  });

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
        serviceSubtitle: t.serviceSubtitle,
        serviceIcon: t.serviceIcon,
        serviceColor: t.serviceColor,
      };
      showTicket(t.position, t.peopleAhead, null);
      // Wait for the print attempt (including its retry) to actually finish
      // before starting the return-to-menu countdown — it used to fire
      // immediately alongside printing, so on a slow/retrying printer the
      // kiosk could reset itself mid-print, before the receipt was even
      // done (or before a failed-print notice had a chance to show).
      await printTicket(myTicket, t.peopleAhead, t.position, t.etaMin);
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
    $('tSvcSub').textContent = myTicket.serviceSubtitle || '';
    $('tCode').textContent = myTicket.code;

    var calledBox = $('tCalled');
    var active = $('tActive');
    if (calledOperator) {
      calledBox.hidden = false;
      calledBox.textContent = myTicket.code + ' — Iltimos, ' + calledOperator + 'ga murojaat qiling';
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
    lastPrintPayload = null;
    btnReprint.hidden = true;
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
      showTicket(0, 0, calledRow.name);
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
