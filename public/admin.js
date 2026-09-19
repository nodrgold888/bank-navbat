/* ==========================================================================
   Admin dashboard — per-service stats + queue management
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var busy = false;
  var lastView = null;

  function fmtWaited(createdAt) {
    var m = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
    return m + ' daq kutmoqda';
  }

  function render(view) {
    lastView = view;
    $('subLine').textContent = 'Ish kuni: ' + view.businessDate + ' — real vaqtda yangilanadi';

    $('kIssued').textContent = view.stats.issued;
    $('kServed').textContent = view.stats.served;
    $('kWaiting').textContent = view.stats.waiting;
    $('kBusiest').textContent = view.report.busiest
      ? view.report.busiest.icon + ' ' + view.report.busiest.name
      : '—';

    // per-service table
    var tb = $('tbody');
    tb.innerHTML = '';
    view.report.byService.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="svc-tag"><span class="swatch" style="background:' +
        r.color +
        '"></span>' +
        r.icon +
        ' ' +
        r.name +
        '</span></td>' +
        '<td class="num">' + r.issued + '</td>' +
        '<td class="num">' + r.served + '</td>' +
        '<td class="num">' + r.noShow + '</td>' +
        '<td class="num">' + (r.cancelled || 0) + '</td>' +
        '<td class="num">' + r.waiting + '</td>' +
        '<td class="num">' + r.avgWaitMin + '</td>' +
        '<td class="num">' + r.avgServeMin + '</td>';
      tb.appendChild(tr);
    });

    // operators status — who's serving which ticket right now
    var svcById = {};
    view.services.forEach(function (s) {
      svcById[s.id] = s;
    });
    var opsTb = $('opsTbody');
    opsTb.innerHTML = '';
    (view.operators || []).forEach(function (o) {
      var tr = document.createElement('tr');
      var statusHtml = o.online
        ? '<span class="op-status-tag online">Onlayn</span>'
        : '<span class="op-status-tag paused">Tanaffusda</span>';
      var ticketHtml = o.current ? o.current.code : '—';
      var svcHtml = o.current
        ? (o.current.serviceIcon ? o.current.serviceIcon + ' ' : '') + o.current.serviceName
        : '—';
      var assignedHtml = o.serviceIds
        .map(function (id) {
          var s = svcById[id];
          return s ? s.icon + ' ' + s.name : id;
        })
        .join(', ');
      tr.innerHTML =
        '<td>' + o.name + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '<td class="num tabnum">' + ticketHtml + '</td>' +
        '<td>' + svcHtml + '</td>' +
        '<td>' + assignedHtml + '</td>';
      opsTb.appendChild(tr);
    });

    // waiting-queue list with cancel buttons
    var q = view.queue || [];
    $('qCount').textContent = q.length;
    $('qCancelled').textContent =
      view.stats.cancelled ? 'Bugun bekor qilingan: ' + view.stats.cancelled : '';

    var list = $('queueList');
    list.innerHTML = '';
    if (!q.length) {
      var empty = document.createElement('div');
      empty.className = 'q-empty';
      empty.textContent = 'Navbatda kutayotgan chiptalar yoʻq';
      list.appendChild(empty);
      return;
    }
    q.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'q-row';
      row.innerHTML =
        '<span class="q-dot" style="background:' + t.serviceColor + '"></span>' +
        '<span class="q-code tabnum">' + t.code + '</span>' +
        '<span class="q-svc">' + t.serviceIcon + ' ' + t.serviceName + '</span>' +
        '<span class="q-wait">' + fmtWaited(t.createdAt) + '</span>' +
        '<button class="q-cancel">Bekor qilish</button>';
      var btn = row.querySelector('button');
      btn.disabled = busy;
      btn.addEventListener('click', function () {
        cancelTicket(t.code);
      });
      list.appendChild(row);
    });
  }

  async function cancelTicket(code) {
    if (busy) return;
    if (!confirm(code + ' chiptasini navbatdan butunlay olib tashlaysizmi?')) return;
    busy = true;
    try {
      await Navbat.post('/api/cancel', { code: code });
      toast('Bekor qilindi: ' + code);
    } catch (err) {
      toast('Xatolik: ' + err.message);
    } finally {
      busy = false;
      if (lastView) render(lastView);
    }
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

  $('btnReset').addEventListener('click', async function () {
    if (!confirm('Bugungi barcha navbat raqamlari nolga tushiriladi. Davom etilsinmi?')) return;
    try {
      await Navbat.post('/api/reset', {});
      toast('Navbat nolga tushirildi');
    } catch (err) {
      toast('Xatolik: ' + err.message);
    }
  });

  Navbat.connect(render, function (online) {
    $('offline').classList.toggle('show', !online);
  });
})();
