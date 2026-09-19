/* ==========================================================================
   Staff panel (one per operator) — single-column, action-first layout
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var OPERATOR_COUNT = 7;
  // Mirrors server.js's OPERATOR_NAME_OVERRIDES — used before the first
  // /api/state response arrives, when the picker/login UI has no server data yet.
  var OPERATOR_NAME_OVERRIDES = { 7: 'Valyuta' };
  var operatorLabel = function (n) {
    return OPERATOR_NAME_OVERRIDES[n] || n + '-operator';
  };
  // Deep link: /staff?operator=3 fixes this station to operator 3 (handy for
  // kiosk-mode bookmarks on each operator's machine).
  var urlOp = Number(new URLSearchParams(location.search).get('operator'));
  var opId =
    urlOp >= 1 && urlOp <= OPERATOR_COUNT
      ? urlOp
      : Number(localStorage.getItem('operatorId')) || null;
  var lastView = null;
  var calledAtTs = null;
  var timerInt = null;
  var busy = false;

  // ---- Operator picker ----
  function buildPicker() {
    var grid = $('opGrid');
    grid.innerHTML = '';
    for (var i = 1; i <= OPERATOR_COUNT; i++) {
      (function (n) {
        var btn = document.createElement('button');
        btn.textContent = operatorLabel(n);
        btn.addEventListener('click', function () {
          chooseOperator(n);
        });
        grid.appendChild(btn);
      })(i);
    }
  }

  function chooseOperator(n) {
    opId = n;
    localStorage.setItem('operatorId', String(n));
    $('opPick').hidden = true;
    $('panel').hidden = false;
    $('opBadge').textContent = String(n);
    $('opTitle').textContent = operatorLabel(n);
    Navbat.post('/api/operator', { operatorId: n, online: true }).catch(function () {});
    if (lastView) render(lastView);
  }

  $('switchOp').addEventListener('click', function () {
    localStorage.removeItem('operatorId');
    opId = null;
    $('panel').hidden = true;
    $('opPick').hidden = false;
  });

  // ---- Actions ----
  async function action(url, body) {
    if (!opId || busy) return;
    busy = true;
    setDisabled(true);
    try {
      var res = await Navbat.post(url, Object.assign({ operatorId: opId }, body || {}));
      if (url === '/api/call-next') {
        toast(res.called ? 'Chaqirildi: ' + res.called.code : 'Navbatda kutayotganlar yoʻq');
      } else if (url === '/api/skip') {
        toast(
          res.called
            ? 'Oʻtkazib yuborildi. Keyingisi: ' + res.called.code
            : 'Oʻtkazib yuborildi. Navbat boʻsh'
        );
      } else if (url === '/api/recall') {
        toast(res.recalled ? 'Qayta chaqirildi: ' + res.recalled.code : 'Qayta chaqirish uchun mijoz yoʻq');
      } else if (url === '/api/cancel') {
        toast('Chipta bekor qilindi: ' + (res.ticket && res.ticket.code));
      }
    } catch (err) {
      toast('Xatolik: ' + err.message);
    } finally {
      busy = false;
      if (lastView) render(lastView);
    }
  }

  $('btnCall').addEventListener('click', function () {
    action('/api/call-next');
  });
  $('btnRecall').addEventListener('click', function () {
    action('/api/recall');
  });
  $('btnSkip').addEventListener('click', function () {
    action('/api/skip');
  });
  $('btnCancel').addEventListener('click', function () {
    var me = lastView && myOp(lastView);
    if (!me || !me.current) return;
    if (!confirm(me.current.code + ' chiptasini butunlay bekor qilasizmi?')) return;
    action('/api/cancel', { code: me.current.code });
  });

  $('statusToggle').addEventListener('click', function () {
    if (!opId || !lastView) return;
    var me = myOp(lastView);
    Navbat.post('/api/operator', { operatorId: opId, online: !(me && me.online) }).catch(function (err) {
      toast('Xatolik: ' + err.message);
    });
  });

  // Space = call next
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space') return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'summary') return;
    e.preventDefault();
    action('/api/call-next');
  });

  function setDisabled(v) {
    $('btnCall').disabled = v;
    $('btnRecall').disabled = v;
    $('btnSkip').disabled = v;
    $('btnCancel').disabled = v;
    $('queues')
      .querySelectorAll('button')
      .forEach(function (b) {
        b.disabled = v;
      });
  }

  function myOp(view) {
    return (view.operators || []).find(function (o) {
      return o.id === opId;
    });
  }

  // ---- "Navbatda kutayotganlar" rows (also: call from a specific queue) ----
  function buildQueues(view) {
    var box = $('queues');
    box.innerHTML = '';
    var me = myOp(view);
    var mine = me ? me.serviceIds : [];
    view.services.forEach(function (s) {
      var assigned = mine.indexOf(s.id) !== -1;
      var row = document.createElement('div');
      row.className = 's2-qrow' + (assigned ? '' : ' s2-qrow-unassigned');
      row.innerHTML =
        '<span class="dot" style="background:' +
        s.color +
        '"></span>' +
        '<span class="s2-qname">' +
        s.icon +
        ' ' +
        s.name +
        '</span>' +
        '<span class="s2-qn tabnum">' +
        s.waiting +
        '</span>' +
        '<button class="s2-qcall">Chaqirish</button>';
      var btn = row.querySelector('button');
      btn.disabled = busy || s.waiting === 0 || !assigned;
      btn.title = assigned ? '' : 'Bu xizmat turi sizga biriktirilmagan';
      btn.addEventListener('click', function () {
        action('/api/call-next', { serviceId: s.id });
      });
      box.appendChild(row);
    });
  }

  // ---- "Operatorlar holati" — who's serving which ticket right now ----
  function buildOpsStatus(view) {
    var box = $('opsStatus');
    box.innerHTML = '';
    (view.operators || []).forEach(function (o) {
      var row = document.createElement('div');
      row.className = 's2-oprow' + (o.id === opId ? ' s2-oprow-me' : '');
      var statusHtml;
      if (!o.online) {
        statusHtml = '<span class="s2-op-status paused">Tanaffusda</span>';
      } else if (o.current) {
        statusHtml =
          '<span class="s2-op-ticket tabnum">' +
          o.current.code +
          '</span><span class="s2-op-svc">' +
          (o.current.serviceIcon ? o.current.serviceIcon + ' ' : '') +
          o.current.serviceName +
          '</span>';
      } else {
        statusHtml = '<span class="s2-op-status idle">Boʻsh</span>';
      }
      row.innerHTML = '<span class="s2-op-name">' + o.name + '</span>' + statusHtml;
      box.appendChild(row);
    });
  }

  // ---- Service-type checkboxes (setup) ----
  function buildSvcChecks(view) {
    var box = $('svcChecks');
    if (box.children.length !== view.services.length) {
      box.innerHTML = '';
      view.services.forEach(function (s) {
        var label = document.createElement('label');
        label.innerHTML =
          '<input type="checkbox" value="' +
          s.id +
          '"><span>' +
          s.icon +
          ' ' +
          s.name +
          '</span>';
        label.querySelector('input').addEventListener('change', onSvcChange);
        box.appendChild(label);
      });
    }
    var me = myOp(view);
    var mine = me ? me.serviceIds : [];
    box.querySelectorAll('input').forEach(function (inp) {
      if (document.activeElement !== inp) inp.checked = mine.indexOf(inp.value) !== -1;
    });
    $('svcSummary').textContent =
      mine.length >= view.services.length ? 'Hammasi' : mine.length + ' ta';
  }

  function onSvcChange() {
    var ids = [];
    $('svcChecks')
      .querySelectorAll('input:checked')
      .forEach(function (inp) {
        ids.push(inp.value);
      });
    if (!ids.length) {
      toast('Kamida bitta xizmat turi tanlanishi kerak');
      if (lastView) buildSvcChecks(lastView);
      return;
    }
    Navbat.post('/api/operator', { operatorId: opId, serviceIds: ids }).catch(function (err) {
      toast('Xatolik: ' + err.message);
    });
  }

  // ---- Render ----
  function render(view) {
    lastView = view;
    if (!opId) return;
    var me = myOp(view);
    if (!me) return;

    // status pill
    var st = $('statusToggle');
    if (me.online) {
      st.textContent = '● Onlayn';
      st.className = 's2-status online';
    } else {
      st.textContent = '● Tanaffusda';
      st.className = 's2-status paused';
    }

    // now serving
    if (me.current) {
      calledAtTs = me.current.calledAt;
      $('nowEmpty').hidden = true;
      $('nowActive').hidden = false;
      $('nowCode').textContent = me.current.code;
      $('nowIcon').textContent = me.current.serviceIcon;
      $('nowName').textContent = me.current.serviceName;
      $('nowSvc').style.color = me.current.serviceColor;
      startTimer();
    } else {
      calledAtTs = null;
      stopTimer();
      $('nowEmpty').hidden = false;
      $('nowActive').hidden = true;
    }

    // primary button subtitle
    if (me.next) {
      $('callSub').textContent =
        'Keyingisi: ' + me.next.code + ' · ' + me.next.serviceIcon + ' ' + me.next.serviceName;
    } else {
      $('callSub').textContent = 'Navbat kutilmoqda';
    }

    // button states
    if (!busy) {
      $('btnCall').disabled = false;
      $('btnRecall').disabled = !me.current;
      $('btnSkip').disabled = !me.current;
    }

    // waiting total + per-queue rows
    var total = 0;
    view.services.forEach(function (s) {
      total += s.waiting;
    });
    $('waitTotal').textContent = total;
    buildQueues(view);
    buildSvcChecks(view);
    buildOpsStatus(view);
  }

  function startTimer() {
    stopTimer();
    updateTimer();
    timerInt = setInterval(updateTimer, 1000);
  }
  function stopTimer() {
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
  }
  function updateTimer() {
    var el = $('nowTimer');
    if (el && calledAtTs) el.textContent = Navbat.elapsed(calledAtTs);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
    }, 2600);
  }

  function onConn(online) {
    $('offline').classList.toggle('show', !online);
  }

  buildPicker();
  if (opId) chooseOperator(opId);
  Navbat.connect(render, onConn);
})();
