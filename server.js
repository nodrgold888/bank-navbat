'use strict';

/**
 * Bank queue ticketing system — single-process backend.
 *
 * Three client types are fed from one source (this server) and stay in sync
 * in real time:
 *   - /kiosk  — customer kiosk / mobile page reached via QR code
 *   - /tv     — TV display (now serving + next in line)
 *   - /staff  — operator panel (call next / recall / skip)
 *   - /qr     — printable QR poster that points phones at the kiosk
 *   - /admin  — admin dashboard (per-service stats)
 *
 * Real time: server -> client via Server-Sent Events (/events). Every state
 * change is pushed to all connected screens. client -> server is plain JSON POST.
 * Clients may also poll GET /api/state if SSE is unavailable.
 *
 * The only third-party dependency is `qrcode` (for the printable poster).
 * All UI strings are Uzbek (Latin). Code / comments stay English.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// A single unexpected error anywhere (a bad request, an edge case in the
// midnight rollover, etc.) must not take down every screen at once — log it
// and keep serving everyone else instead of crashing the whole process.
process.on('uncaughtException', (err) => {
  console.error('KUTILMAGAN XATO (jarayon davom etadi):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('KUTILMAGAN PROMISE XATOSI (jarayon davom etadi):', err);
});

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

// Bumped every process start (i.e. every deploy/restart) and appended as
// "?v=" on every script/stylesheet reference in served HTML pages below.
// A CDN or intermediate proxy in front of a custom domain can cache static
// assets by extension regardless of Cache-Control (a very common default),
// which would otherwise mean a JS/CSS fix never actually reaches a browser
// after deploying it — the URL itself has to change to force a fresh fetch.
const ASSET_VERSION = Date.now();

const OPERATOR_COUNT = 7;
// Each operator is dedicated to a fixed subset of services, instead of the
// "handles every service" default.
const DEDICATED_OPERATORS = {
  1: ['depozitlar', 'tolovlar', 'escrow'],
  2: ['kartalar', 'terminalar'],
  3: ['kreditlash'],
  4: ['kreditlash'],
  5: ['kartalar', 'terminalar'],
  6: ['depozitlar', 'tolovlar', 'escrow'],
  7: ['valyuta'],
};
const OPERATOR_NAME_OVERRIDES = { 7: 'Valyuta' };

// The service types. Each has an independent, daily-incrementing queue.
const DEFAULT_SERVICES = [
  {
    id: 'kreditlash',
    name: 'Kreditlash',
    subtitle: 'Isteʼmol, avtokredit, ipoteka va mikroqarz bo‘yicha shartlar, foiz stavkalari, ariza topshirish hamda to‘lov jadvali yuzasidan xizmatlar.',
    prefix: 'A',
    icon: '🏦',
    color: '#6366f1',
  },
  {
    id: 'depozitlar',
    name: 'Depozitlar',
    subtitle:
      "Omonat va jamg‘arma hisobini ochish, mablag‘larni saqlash, foiz hamda muddat shartlarini tanlash va chet el safarlari uchun bank ma’lumotnomasini olish.",
    prefix: 'B',
    icon: '💰',
    color: '#16a34a',
  },
  {
    id: 'tolovlar',
    name: 'Toʻlovlar va pul oʻtkazmalari',
    subtitle:
      "Kontrakt, kommunal xizmat, jarima va boshqa to‘lovlarni amalga oshirish, shuningdek ichki hamda xalqaro pul o‘tkazmalari bo‘yicha yordam.",
    prefix: 'C',
    icon: '💸',
    color: '#d97706',
  },
  {
    id: 'kartalar',
    name: 'Bank kartalari',
    subtitle:
      "Visa, Uzcard va Humo kartalarini ochish, qayta chiqarish, bloklash, PIN-kodni almashtirish, hisobga biriktirish va karta bo‘yicha maslahatlar.",
    prefix: 'D',
    icon: '💳',
    color: '#0891b2',
  },
  {
    id: 'terminalar',
    name: 'Terminalar bilan ishlash',
    subtitle:
      "POS-terminalni ulash va sozlash, texnik xizmat ko‘rsatish, ishlamay qolgan terminalni tekshirish va savdo nuqtalari bo‘yicha murojaatlar.",
    prefix: 'E',
    icon: '🖥️',
    color: '#0d9488',
  },
  {
    id: 'escrow',
    name: 'Escrow xizmati',
    subtitle: "Uy 🏠 va avtomashina 🚗 oldi-sotdi bitimlarida mablag‘ni xavfsiz saqlash, shartlar bajarilgach to‘lovni o'tkazib berish xizmati.",
    prefix: 'F',
    icon: '🤝',
    color: '#7c3aed',
  },
  {
    id: 'valyuta',
    name: 'Valyuta ayirboshlash',
    subtitle: "Dollar, yevro va boshqa xorijiy valyutalarni so‘mga almashtirish, amaldagi kurslar va ayirboshlash tartibi bo‘yicha ma’lumot olish.",
    prefix: 'G',
    icon: '💱',
    color: '#dc2626',
  },
];

// Average handling time per customer (minutes) until real data is collected.
const DEFAULT_SERVICE_MIN = 5;
const MIN_SERVICE_MIN = 2;
const MAX_SERVICE_MIN = 20;
const DURATION_SAMPLE_SIZE = 30;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @typedef {'waiting'|'called'|'served'|'no_show'} TicketStatus */

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function freshState() {
  const counters = {};
  for (const s of DEFAULT_SERVICES) counters[s.id] = 0;

  const operators = [];
  for (let i = 1; i <= OPERATOR_COUNT; i++) {
    operators.push({
      id: i,
      name: OPERATOR_NAME_OVERRIDES[i] || `${i}-operator`,
      online: true,
      serviceIds: DEDICATED_OPERATORS[i] || DEFAULT_SERVICES.map((s) => s.id),
      currentTicketId: null,
    });
  }

  return {
    businessDate: todayStr(),
    services: DEFAULT_SERVICES.map((s) => ({ ...s })),
    counters, // per service: last issued number today
    tickets: [], // today's tickets (all statuses)
    operators,
    lastCall: null, // { ticketId, code, operatorId, serviceId, ts, recall, seq }
    callSeq: 0,
    serviceDurations: [], // seconds, rolling sample (global)
  };
}

let state = freshState();
// Retain recent calls so a polling TV does not miss simultaneous operators.
let recentCalls = [];

// ---------------------------------------------------------------------------
// Persistence (survives restart during the day; resets at midnight)
// ---------------------------------------------------------------------------

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Could not save state:', err.message);
    }
  }, 400);
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = freshState();

    base.businessDate = saved.businessDate || base.businessDate;
    if (saved.counters) {
      for (const k of Object.keys(base.counters)) {
        if (typeof saved.counters[k] === 'number') base.counters[k] = saved.counters[k];
      }
    }
    if (Array.isArray(saved.tickets)) base.tickets = saved.tickets;
    if (Array.isArray(saved.serviceDurations)) base.serviceDurations = saved.serviceDurations;
    base.lastCall = saved.lastCall || null;
    base.callSeq = Number(saved.callSeq) || 0;

    if (Array.isArray(saved.operators)) {
      for (const op of base.operators) {
        const s = saved.operators.find((o) => o.id === op.id);
        if (!s) continue;
        op.online = typeof s.online === 'boolean' ? s.online : true;
        if (Array.isArray(s.serviceIds) && s.serviceIds.length) {
          const valid = s.serviceIds.filter((id) => base.services.some((sv) => sv.id === id));
          op.serviceIds = valid.length ? valid : base.services.map((sv) => sv.id);
        }
        op.currentTicketId = s.currentTicketId || null;
      }
    }

    state = base;
    for (const op of state.operators) {
      if (op.currentTicketId && !state.tickets.some((t) => t.id === op.currentTicketId)) {
        op.currentTicketId = null;
      }
    }
    checkRollover();
    console.log('Restored previous state from', DATA_FILE);
  } catch {
    state = freshState();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function svc(id) {
  return state.services.find((s) => s.id === id) || null;
}
function getOp(id) {
  return state.operators.find((o) => o.id === Number(id)) || null;
}
function getTicket(id) {
  return state.tickets.find((t) => t.id === id) || null;
}
function formatCode(service, n) {
  return `${service.prefix}${String(n).padStart(3, '0')}`;
}
function serviceMeta(id) {
  const s = svc(id);
  return s
    ? { id: s.id, name: s.name, subtitle: s.subtitle, icon: s.icon, color: s.color, prefix: s.prefix }
    : { id, name: id, subtitle: '', icon: '•', color: '#64748b', prefix: '' };
}

// Ticket counters reset daily at midnight, per service type.
function checkRollover() {
  const today = todayStr();
  if (state.businessDate !== today) {
    console.log(`New business day: ${state.businessDate} -> ${today}. Queues reset.`);
    resetDay();
    return true;
  }
  return false;
}

function resetDay() {
  state.businessDate = todayStr();
  for (const k of Object.keys(state.counters)) state.counters[k] = 0;
  state.tickets = [];
  state.lastCall = null;
  state.callSeq = 0;
  state.serviceDurations = [];
  for (const o of state.operators) o.currentTicketId = null;
}

function avgServiceMin() {
  if (!state.serviceDurations.length) return DEFAULT_SERVICE_MIN;
  const meanSec =
    state.serviceDurations.reduce((a, b) => a + b, 0) / state.serviceDurations.length;
  return Math.min(MAX_SERVICE_MIN, Math.max(MIN_SERVICE_MIN, meanSec / 60));
}

function onlineServersFor(serviceId) {
  const n = state.operators.filter(
    (o) => o.online && o.serviceIds.includes(serviceId)
  ).length;
  return Math.max(1, n);
}

function waitingTickets(serviceIds) {
  const set = Array.isArray(serviceIds) ? new Set(serviceIds) : null;
  return state.tickets
    .filter((t) => t.status === 'waiting' && (!set || set.has(t.serviceId)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function waitingCountFor(serviceId) {
  return state.tickets.filter((t) => t.status === 'waiting' && t.serviceId === serviceId).length;
}

function etaMinFor(serviceId, peopleAhead) {
  const raw = (peopleAhead / onlineServersFor(serviceId)) * avgServiceMin();
  return Math.max(0, Math.round(raw));
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

function issueTicket(serviceId) {
  checkRollover();
  const service = svc(serviceId);
  if (!service) throw new HttpError(400, 'Nomaʼlum xizmat turi');

  state.counters[serviceId] = (state.counters[serviceId] || 0) + 1;
  const num = state.counters[serviceId];
  const ticket = {
    id: crypto.randomUUID(),
    code: formatCode(service, num),
    num,
    serviceId,
    status: 'waiting',
    createdAt: Date.now(),
    calledAt: null,
    endedAt: null,
    operatorId: null,
  };
  state.tickets.push(ticket);
  prefetchCallVoices(ticket.code, serviceId);

  const peopleAhead = state.tickets.filter(
    (t) => t.status === 'waiting' && t.serviceId === serviceId && t.createdAt < ticket.createdAt
  ).length;

  return { ticket, peopleAhead, etaMin: etaMinFor(serviceId, peopleAhead) };
}

function recordDuration(ticket) {
  if (!ticket.calledAt || !ticket.endedAt) return;
  const sec = (ticket.endedAt - ticket.calledAt) / 1000;
  if (sec <= 0 || sec > 3600) return;
  state.serviceDurations.push(sec);
  if (state.serviceDurations.length > DURATION_SAMPLE_SIZE) {
    state.serviceDurations.splice(0, state.serviceDurations.length - DURATION_SAMPLE_SIZE);
  }
}

function completeCurrent(op, disposition /* 'served' | 'no_show' */) {
  if (!op.currentTicketId) return null;
  const cur = getTicket(op.currentTicketId);
  if (cur && cur.status === 'called') {
    cur.status = disposition;
    cur.endedAt = Date.now();
    if (disposition === 'served') recordDuration(cur);
  }
  op.currentTicketId = null;
  return cur;
}

/**
 * Assign the next waiting ticket to an operator.
 * @param {object} op
 * @param {string|null} serviceId  when set, pull only from that queue;
 *                                 otherwise auto-pull the longest-waiting
 *                                 ticket across the operator's assigned queues.
 */
function assignNext(op, serviceId) {
  let pool = state.tickets.filter((t) => t.status === 'waiting');
  pool = serviceId
    ? pool.filter((t) => t.serviceId === serviceId)
    : pool.filter((t) => op.serviceIds.includes(t.serviceId));
  pool.sort((a, b) => a.createdAt - b.createdAt);

  const next = pool[0];
  if (!next) {
    op.currentTicketId = null;
    return null;
  }
  next.status = 'called';
  next.operatorId = op.id;
  next.calledAt = Date.now();
  op.currentTicketId = next.id;
  op.online = true;

  state.callSeq += 1;
  state.lastCall = {
    ticketId: next.id,
    code: next.code,
    operatorId: op.id,
    serviceId: next.serviceId,
    ts: Date.now(),
    recall: false,
    seq: state.callSeq,
  };
  prefetchFullCall(next.code, op.id, true); // so a later "Qayta chaqirish" is instant too
  return next;
}

function callNext(operatorId, serviceId) {
  checkRollover();
  const op = getOp(operatorId);
  if (!op) throw new HttpError(400, 'Nomaʼlum operator');
  if (serviceId && !svc(serviceId)) throw new HttpError(400, 'Nomaʼlum xizmat turi');
  if (serviceId && !op.serviceIds.includes(serviceId)) {
    throw new HttpError(403, 'Bu xizmat turi sizga biriktirilmagan');
  }
  completeCurrent(op, 'served');
  const next = assignNext(op, serviceId || null);
  return { called: next };
}

function skipCurrent(operatorId) {
  checkRollover();
  const op = getOp(operatorId);
  if (!op) throw new HttpError(400, 'Nomaʼlum operator');

  let svcId = null;
  if (op.currentTicketId) {
    const c = getTicket(op.currentTicketId);
    // Only reuse the ticket's service if the operator is still assigned to
    // it — admin may have reassigned them while this ticket was in
    // progress, and assignNext() trusts an explicit serviceId without
    // re-checking op.serviceIds (unlike its auto-pull branch), so passing
    // a now-unassigned id here would let them skip straight into a queue
    // they're no longer configured for.
    if (c && op.serviceIds.includes(c.serviceId)) svcId = c.serviceId;
  }
  const had = Boolean(op.currentTicketId);
  completeCurrent(op, 'no_show');

  // Continue from the same queue; fall back to auto if it is now empty.
  let next = assignNext(op, svcId);
  if (!next && svcId) next = assignNext(op, null);
  return { skipped: had, called: next };
}

/**
 * Call a specific ticket by code, instead of just "next in line" — used to
 * pull a particular waiting ticket out of order, or to bring back one that
 * was previously skipped (status 'no_show') and try it again.
 */
function callTicket(operatorId, code) {
  checkRollover();
  const op = getOp(operatorId);
  if (!op) throw new HttpError(400, 'Nomaʼlum operator');
  const t = state.tickets.find(
    (x) => x.code === code && (x.status === 'waiting' || x.status === 'no_show')
  );
  if (!t) throw new HttpError(404, 'Chipta topilmadi yoki allaqachon yakunlangan');
  if (!op.serviceIds.includes(t.serviceId)) {
    throw new HttpError(403, 'Bu xizmat turi sizga biriktirilmagan');
  }
  completeCurrent(op, 'served');
  t.status = 'called';
  t.operatorId = op.id;
  t.calledAt = Date.now();
  t.endedAt = null;
  op.currentTicketId = t.id;
  op.online = true;

  state.callSeq += 1;
  state.lastCall = {
    ticketId: t.id,
    code: t.code,
    operatorId: op.id,
    serviceId: t.serviceId,
    ts: Date.now(),
    recall: false,
    seq: state.callSeq,
  };
  return { called: t };
}

function recall(operatorId) {
  checkRollover();
  const op = getOp(operatorId);
  if (!op) throw new HttpError(400, 'Nomaʼlum operator');
  if (!op.currentTicketId) return { recalled: null };
  const cur = getTicket(op.currentTicketId);
  if (!cur) return { recalled: null };

  state.callSeq += 1;
  state.lastCall = {
    ticketId: cur.id,
    code: cur.code,
    operatorId: op.id,
    serviceId: cur.serviceId,
    ts: Date.now(),
    recall: true,
    seq: state.callSeq,
  };
  return { recalled: cur };
}

function updateOperator(operatorId, patch) {
  const op = getOp(operatorId);
  if (!op) throw new HttpError(400, 'Nomaʼlum operator');
  if (typeof patch.online === 'boolean') op.online = patch.online;
  if (Array.isArray(patch.serviceIds)) {
    const valid = patch.serviceIds.filter((id) => state.services.some((s) => s.id === id));
    op.serviceIds = valid.length ? valid : state.services.map((s) => s.id);
  }
  return { operator: op };
}

/** Remove an unwanted ticket (junk, duplicate, test). Not a no-show. */
function cancelTicket(code) {
  checkRollover();
  const t = state.tickets.find(
    (x) => x.code === code && (x.status === 'waiting' || x.status === 'called')
  );
  if (!t) throw new HttpError(404, 'Chipta topilmadi yoki allaqachon yakunlangan');
  t.status = 'cancelled';
  t.endedAt = Date.now();
  // If an operator is currently on this ticket, free them.
  for (const op of state.operators) {
    if (op.currentTicketId === t.id) op.currentTicketId = null;
  }
  return { ticket: t };
}

// ---------------------------------------------------------------------------
// View model — one payload for every client
// ---------------------------------------------------------------------------

function serviceReport(s) {
  const ts = state.tickets.filter((t) => t.serviceId === s.id);
  const served = ts.filter((t) => t.status === 'served');
  const noShow = ts.filter((t) => t.status === 'no_show');
  const waitDur = served
    .concat(noShow)
    .filter((t) => t.calledAt)
    .map((t) => (t.calledAt - t.createdAt) / 60000);
  const serveDur = served
    .filter((t) => t.calledAt && t.endedAt)
    .map((t) => (t.endedAt - t.calledAt) / 60000);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  return {
    id: s.id,
    name: s.name,
    icon: s.icon,
    color: s.color,
    prefix: s.prefix,
    issued: ts.length,
    served: served.length,
    noShow: noShow.length,
    cancelled: ts.filter((t) => t.status === 'cancelled').length,
    waiting: ts.filter((t) => t.status === 'waiting').length,
    avgWaitMin: Math.round(avg(waitDur)),
    avgServeMin: Math.round(avg(serveDur)),
  };
}

function buildView() {
  const services = state.services.map((s) => {
    const waiting = waitingCountFor(s.id);
    return {
      id: s.id,
      name: s.name,
      subtitle: s.subtitle,
      prefix: s.prefix,
      icon: s.icon,
      color: s.color,
      waiting,
      etaMin: etaMinFor(s.id, waiting),
      nextNumber: formatCode(s, (state.counters[s.id] || 0) + 1),
    };
  });

  const board = state.operators.map((o) => {
    const cur = o.currentTicketId ? getTicket(o.currentTicketId) : null;
    const m = cur ? serviceMeta(cur.serviceId) : null;
    return {
      id: o.id,
      name: o.name,
      online: o.online,
      ticketCode: cur ? cur.code : null,
      serviceName: m ? m.name : null,
      serviceIcon: m ? m.icon : null,
      serviceColor: m ? m.color : null,
      calledAt: cur ? cur.calledAt : null,
    };
  });

  const waitingSorted = waitingTickets(null);
  const mapWaiting = (t) => {
    const m = serviceMeta(t.serviceId);
    return {
      code: t.code,
      serviceId: t.serviceId,
      serviceName: m.name,
      serviceIcon: m.icon,
      serviceColor: m.color,
      createdAt: t.createdAt,
    };
  };
  // Was capped at 8 — cut off queues once more than 8 people total were
  // waiting across ALL services combined, so the TV board could silently
  // stop showing some queues entirely. The TV scrolls this list now, so
  // send everyone waiting (same generous cap as the admin queue below,
  // just for payload size, not for hiding anyone).
  const waitingList = waitingSorted.slice(0, 120).map(mapWaiting);
  // Full waiting queue for the admin cancel UI — capped for payload size.
  const fullQueue = waitingSorted.slice(0, 120).map(mapWaiting);
  // Skipped ("oʻtkazib yuborilgan") tickets — kept visible and callable so an
  // operator can bring one back instead of it vanishing once skipped. Most
  // recently skipped first.
  const skippedList = state.tickets
    .filter((t) => t.status === 'no_show')
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, 60)
    .map(mapWaiting);

  const operators = state.operators.map((o) => {
    const cur = o.currentTicketId ? getTicket(o.currentTicketId) : null;
    const curMeta = cur ? serviceMeta(cur.serviceId) : null;
    const queue = waitingTickets(o.serviceIds);
    const nextMeta = queue[0] ? serviceMeta(queue[0].serviceId) : null;
    return {
      id: o.id,
      name: o.name,
      online: o.online,
      serviceIds: o.serviceIds.slice(),
      current: cur
        ? {
            code: cur.code,
            serviceId: cur.serviceId,
            serviceName: curMeta.name,
            serviceIcon: curMeta.icon,
            serviceColor: curMeta.color,
            calledAt: cur.calledAt,
          }
        : null,
      next: queue[0]
        ? { code: queue[0].code, serviceName: nextMeta.name, serviceIcon: nextMeta.icon }
        : null,
      waitingCount: queue.length,
    };
  });

  const lastCall = state.lastCall
    ? (() => {
        const m = serviceMeta(state.lastCall.serviceId);
        return {
          code: state.lastCall.code,
          operatorId: state.lastCall.operatorId,
          operatorName:
            getOp(state.lastCall.operatorId)?.name || `${state.lastCall.operatorId}-operator`,
          serviceName: m.name,
          serviceIcon: m.icon,
          serviceColor: m.color,
          ts: state.lastCall.ts,
          recall: state.lastCall.recall,
          seq: state.lastCall.seq,
        };
      })()
    : null;

  const byService = state.services.map(serviceReport);
  const busiest = byService
    .filter((r) => r.issued > 0)
    .sort((a, b) => b.issued - a.issued)[0] || null;

  return {
    assetVersion: ASSET_VERSION,
    tts: TTS_ENABLED,
    // Default TV sound: 'voice' (spoken call) or 'ringtone' (original bell only). Env TV_SOUND_MODE.
    tvMode: process.env.TV_SOUND_MODE === 'ringtone' ? 'ringtone' : 'voice',
    businessDate: state.businessDate,
    services,
    board,
    waitingList,
    queue: fullQueue,
    skipped: skippedList,
    operators,
    lastCall,
    recentCalls,
    stats: {
      issued: state.tickets.length,
      served: state.tickets.filter((t) => t.status === 'served').length,
      noShow: state.tickets.filter((t) => t.status === 'no_show').length,
      cancelled: state.tickets.filter((t) => t.status === 'cancelled').length,
      waiting: state.tickets.filter((t) => t.status === 'waiting').length,
      avgServiceMin: Math.round(avgServiceMin()),
    },
    report: {
      byService,
      busiest: busiest ? { id: busiest.id, name: busiest.name, icon: busiest.icon } : null,
    },
  };
}

// The view is identical between mutations, so build + serialize it once and
// hand the same string to every poller and SSE client. This keeps hundreds of
// concurrent /api/state polls and SSE writes cheap (a buffer copy, no work).
let viewJsonCache = null;
let ssePayloadCache = null;
function invalidateView() {
  viewJsonCache = null;
  ssePayloadCache = null;
}
function viewJson() {
  if (viewJsonCache === null) viewJsonCache = JSON.stringify(buildView());
  return viewJsonCache;
}
function ssePayload() {
  if (ssePayloadCache === null) ssePayloadCache = `event: state\ndata: ${viewJson()}\n\n`;
  return ssePayloadCache;
}

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(ssePayload());

  sseClients.add(res);
  // A real (observable) heartbeat: keeps the connection warm through proxies
  // AND lets the client tell a working stream from a silently-buffered one,
  // so it can back its polling right off when SSE is healthy.
  const heartbeat = setInterval(() => {
    try {
      res.write('event: ping\ndata: 1\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

function broadcast() {
  const payload = ssePayload();
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** Called after every mutation. */
function commit() {
  if (!state.lastCall) recentCalls = [];
  else if (!recentCalls.length || recentCalls[recentCalls.length - 1].ts !== state.lastCall.ts || recentCalls[recentCalls.length - 1].seq !== state.lastCall.seq) {
    recentCalls.push({ ...state.lastCall });
    recentCalls = recentCalls.slice(-100);
  }
  invalidateView();
  broadcast();
  persist();
}

// ---------------------------------------------------------------------------
// QR code (points phones at the kiosk)
// ---------------------------------------------------------------------------

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function baseUrl() {
  // Explicit override wins; then common host-provided vars (Render, etc.); then LAN.
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  const lan = lanAddresses()[0];
  return `http://${lan || 'localhost'}:${PORT}`;
}

const KIOSK_URL = `${baseUrl()}/kiosk`;
let qrDataUrl = null;

QRCode.toDataURL(KIOSK_URL, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
  .then((d) => {
    qrDataUrl = d;
  })
  .catch((err) => console.error('QR generation failed:', err.message));

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const PAGE_ROUTES = {
  '/': 'index.html',
  '/kiosk': 'kiosk.html',
  // Dedicated path for the physical shared terminal, in addition to
  // "/kiosk?shared=1" — a URL *path* survives far more domain-forwarding/
  // proxy setups than a query string does (many strip query strings on
  // forwarding but preserve the path), so this is the reliable signal;
  // the query flag is kept only as a secondary fallback. See kiosk.js.
  '/kiosk-terminal': 'kiosk.html',
  '/tv': 'tv.html',
  '/staff': 'staff.html',
  '/qr': 'qr.html',
  '/admin': 'admin.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

// Appends "?v=<ASSET_VERSION>" to same-origin script/stylesheet references
// (src="/x.js", href="/x.css") in served HTML — never touches absolute
// URLs (Google Fonts etc.), since those already have their own cache story.
function withAssetVersion(html) {
  return html.replace(
    /((?:src|href)=")(\/[^"]+\.(?:js|css))(")/g,
    (m, pre, url, post) => `${pre}${url}?v=${ASSET_VERSION}${post}`
  );
}

function serveStatic(req, res, urlPath) {
  let rel = PAGE_ROUTES[urlPath] || urlPath.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';

  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('403');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — sahifa topilmadi');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    if (ext === '.html') {
      data = Buffer.from(withAssetVersion(data.toString('utf8')), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // "no-cache" alone still lets a misbehaving proxy/CDN cache the
      // response as long as it wants (some ignore weak validators
      // entirely) — "no-store" plus the "?v=" cache-buster on every asset
      // URL above is the belt-and-suspenders fix: even a cache that
      // ignores this header outright still can't serve a stale file under
      // a URL that changed.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    let done = false;
    const settle = (fn, val) => {
      if (done) return;
      done = true;
      fn(val);
    };
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > 1e6) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return; // 'close' below settles the promise instead
      if (!raw) return settle(resolve, {});
      try {
        settle(resolve, JSON.parse(raw));
      } catch {
        settle(resolve, {});
      }
    });
    req.on('error', () => settle(reject, new HttpError(400, "So'rovni o'qib bo'lmadi")));
    // req.destroy() above fires 'close' (not 'end') — without this, the
    // request would hang forever waiting on an 'end' event that never comes.
    // A plain early disconnect (flaky kiosk network) also fires 'close'
    // without ever hitting the size cap — that used to leave this promise
    // (and the request's whole async handler) pending forever instead of
    // failing fast like the oversized-body path already did.
    req.on('close', () => {
      if (tooLarge) return settle(reject, new HttpError(413, "So'rov hajmi juda katta"));
      settle(reject, new HttpError(400, "So'rov uzildi"));
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const API_HANDLERS = {
  'POST /api/ticket': async (body) => {
    const { ticket, peopleAhead, etaMin } = issueTicket(body.serviceId);
    commit();
    const m = serviceMeta(ticket.serviceId);
    return {
      ok: true,
      ticket: {
        code: ticket.code,
        serviceId: ticket.serviceId,
        serviceName: m.name,
        serviceSubtitle: m.subtitle,
        serviceIcon: m.icon,
        serviceColor: m.color,
        position: peopleAhead + 1,
        peopleAhead,
        etaMin,
      },
    };
  },

  'POST /api/call-next': async (body) => {
    const { called } = callNext(body.operatorId, body.serviceId || null);
    commit();
    return {
      ok: true,
      called: called
        ? { code: called.code, serviceName: serviceMeta(called.serviceId).name }
        : null,
    };
  },

  'POST /api/call-ticket': async (body) => {
    const { called } = callTicket(body.operatorId, String(body.code || '').trim());
    commit();
    return {
      ok: true,
      called: called
        ? { code: called.code, serviceName: serviceMeta(called.serviceId).name }
        : null,
    };
  },

  'POST /api/recall': async (body) => {
    const { recalled } = recall(body.operatorId);
    commit();
    return { ok: true, recalled: recalled ? { code: recalled.code } : null };
  },

  'POST /api/skip': async (body) => {
    const { skipped, called } = skipCurrent(body.operatorId);
    commit();
    return {
      ok: true,
      skipped,
      called: called
        ? { code: called.code, serviceName: serviceMeta(called.serviceId).name }
        : null,
    };
  },

  'POST /api/operator': async (body) => {
    const { operator } = updateOperator(body.operatorId, body);
    commit();
    return {
      ok: true,
      operator: { id: operator.id, online: operator.online, serviceIds: operator.serviceIds },
    };
  },

  'POST /api/cancel': async (body) => {
    const { ticket } = cancelTicket(String(body.code || '').trim());
    commit();
    return { ok: true, ticket: { code: ticket.code } };
  },

  'POST /api/reset': async () => {
    resetDay();
    commit();
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Text-to-speech for the TV (Lynx Uzbek voice, with Azure as a fallback provider)
// ---------------------------------------------------------------------------
// The browser never sees a provider key: the TV asks GET /api/tts?code=B001&operator=6
// and this server calls the configured provider. The endpoint takes structured params and
// builds the announcement itself, so it can't be used to synthesize arbitrary speech or
// burn quota; results are cached and uncached synthesis is rate-limited.
//   LYNX_API_KEY         (preferred) - Lynx AI Uzbekistan server API key
//   LYNX_TTS_ENDPOINT    (optional)  - defaults to the Lynx production speech endpoint
//   AZURE_SPEECH_KEY     (required to enable)  - a key from the Azure Speech resource
//   AZURE_SPEECH_REGION  (e.g. "westeurope")   - the resource's region
//   AZURE_SPEECH_VOICE   (default uz-UZ-MadinaNeural; uz-UZ-SardorNeural is the male voice)
const LYNX_API_KEY = process.env.LYNX_API_KEY || '';
const LYNX_TTS_ENDPOINT = process.env.LYNX_TTS_ENDPOINT || 'https://api.lynx-ai.uz/v1/audio/speech';
const LYNX_TTS_VOICE = process.env.LYNX_TTS_VOICE || 'lynx_voice_mira_v1';
const LYNX_TTS_LANGUAGE = process.env.LYNX_TTS_LANGUAGE || 'uz';
const LYNX_TTS_EXPRESSIVENESS = process.env.LYNX_TTS_EXPRESSIVENESS || 'natural';
// The voice Lynx reports it actually used (x-lynx-voice), to confirm LYNX_TTS_VOICE took effect.
let lynxServedVoice = null;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
const AZURE_SPEECH_VOICE = process.env.AZURE_SPEECH_VOICE || 'uz-UZ-MadinaNeural';
const AZURE_SPEECH_ENDPOINT =
  process.env.AZURE_SPEECH_ENDPOINT ||
  (AZURE_SPEECH_REGION ? `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1` : '');
const TTS_PROVIDER = LYNX_API_KEY ? 'lynx' : AZURE_SPEECH_KEY && AZURE_SPEECH_ENDPOINT ? 'azure' : '';
// Cloud speech bills per request, so it stays OFF unless TV_CLOUD_SPEECH=on is set; the TV
// otherwise announces calls from the bundled Mira recordings (public/audio/mira), which are
// free and come straight from the repo. (Named TV_CLOUD_SPEECH, not the earlier
// TV_CLOUD_VOICE, so a leftover setting on the host doesn't switch the cloud back on.)
const CLOUD_VOICE_ON = process.env.TV_CLOUD_SPEECH === 'on';
const TTS_ENABLED = Boolean(TTS_PROVIDER) && CLOUD_VOICE_ON;

const TTS_CACHE_MAX = 600;
const TTS_RATE_PER_MIN = Number(process.env.TTS_RATE_PER_MIN) || 0; // 0 = no limit (cloud speech is off by default)
/** @type {Map<string, Buffer>} */
const ttsCache = new Map();
/** @type {Map<string, Promise<Buffer>>} */
const ttsInflight = new Map();
let ttsWindowStart = 0;
let ttsWindowCount = 0;

function xmlEscape(text) {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

const LETTER_SPEECH = { A: 'Ey', B: 'Bi', C: 'Si', D: 'Di', E: 'I', F: 'Ef', G: 'Ji' };
const DIGIT_SPEECH = ['nol', 'bir', 'ikki', 'uch', "to‘rt", 'besh', 'olti', 'yetti', 'sakkiz', "to‘qqiz"];
const OPERATOR_SPEECH = ['birinchi', 'ikkinchi', 'uchinchi', "to‘rtinchi", 'beshinchi', 'oltinchi', 'yettinchi'];
const NUMBER_ONES = ['', 'bir', 'ikki', 'uch', "to‘rt", 'besh', 'olti', 'yetti', 'sakkiz', "to‘qqiz"];
const NUMBER_TENS = ['', "o‘n", 'yigirma', "o‘ttiz", 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', "to‘qson"];

function operatorInstruction(operatorId) {
  return operatorId === 7
    ? 'valyuta kassasiga murojaat qiling.'
    : `${OPERATOR_SPEECH[operatorId - 1]} aperatorga murojaat qiling.`;
}

function buildAnnouncementText(code, operatorId, recall) {
  const prefix = recall ? 'Qayta chaqiruv. ' : '';
  return `${prefix}Hurmatli ${spokenCode(code)} raqamli mijoz, ${operatorInstruction(operatorId)}`;
}

// The announcement is built from two independently cached pieces so nothing has to be
// synthesized when an operator presses "call": the ticket part is prepared as soon as the
// ticket exists (its code is known), and the 7 operator parts are prepared at boot.
// Numbers are read as words ("yuz yigirma uch"), like the bundled Mira clips; reading them
// digit by digit ("bir ikki uch") sounded robotic. Codes past 999 fall back to digits.
function numberWords(n) {
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [
    hundreds ? (hundreds === 1 ? 'yuz' : `${NUMBER_ONES[hundreds]} yuz`) : '',
    NUMBER_TENS[Math.floor(rest / 10)],
    NUMBER_ONES[rest % 10],
  ].filter(Boolean).join(' ');
}
function spokenCode(code) {
  const words = numberWords(Number(code.slice(1)));
  const number = words || code.slice(1).split('').map((digit) => DIGIT_SPEECH[Number(digit)]).join(' ');
  return `${LETTER_SPEECH[code[0]]}, ${number}`;
}
function buildTicketPartText(code, recall) {
  return `${recall ? 'Qayta chaqiruv. ' : ''}Hurmatli ${spokenCode(code)} raqamli mijoz,`;
}
function buildOperatorPartText(operatorId) {
  return operatorInstruction(operatorId);
}
function buildNumberPartText(number) {
  const words = [NUMBER_TENS[Math.floor(number / 10)], NUMBER_ONES[number % 10]].filter(Boolean).join(' ');
  return `${words} raqamli mijoz,`;
}

function bundledClipText(key) {
  const letter = key.match(/^l-([A-G])$/);
  if (letter) return LETTER_SPEECH[letter[1]];
  if (key === 'recall') return 'Qayta chaqiruv.';
  const operator = key.match(/^op-([1-7])$/);
  if (operator) return buildOperatorPartText(Number(operator[1]));
  const hundred = key.match(/^h-([1-9])$/);
  if (hundred) {
    const n = Number(hundred[1]);
    return n === 1 ? 'yuz' : `${NUMBER_ONES[n]} yuz`;
  }
  const hundredTicket = key.match(/^ht-([1-9])$/);
  if (hundredTicket) return `${bundledClipText(`h-${hundredTicket[1]}`)} raqamli mijoz.`;
  const number = key.match(/^n-([1-9]|[1-9]\d)$/);
  if (number) return buildNumberPartText(Number(number[1])).replace(/,$/, '.');
  return null;
}

/** Cached, de-duplicated, rate-limited synthesis. Resolves null when the rate limit is hit. */
function cachedSynthesis(key, text) {
  const hit = ttsCache.get(key);
  if (hit) return Promise.resolve(hit);
  let job = ttsInflight.get(key);
  if (job) return job;
  const now = Date.now();
  if (now - ttsWindowStart > 60000) {
    ttsWindowStart = now;
    ttsWindowCount = 0;
  }
  if (TTS_RATE_PER_MIN && ++ttsWindowCount > TTS_RATE_PER_MIN) return Promise.resolve(null);
  job = synthesize(text)
    .then((audio) => {
      ttsCache.set(key, audio);
      while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
      return audio;
    })
    .finally(() => ttsInflight.delete(key));
  ttsInflight.set(key, job);
  return job;
}

const ticketPartKey = (code, recall) => `${TTS_PROVIDER}|ticket|${recall ? 1 : 0}|${code}`;
const operatorPartKey = (operatorId) => `${TTS_PROVIDER}|operator|${operatorId}`;
const numberPartKey = (number) => `${TTS_PROVIDER}|number|${number}`;

// The TV plays each call as ONE whole sentence (pieces joined together sounded robotic).
// A sentence depends on the operator, so when a ticket is issued we prepare it for every
// operator that serves that service (at most two here); by the time someone presses
// "call" the audio is already cached and plays at once.
const fullCallKey = (code, operatorId, recall) => `${TTS_PROVIDER}|${recall ? 1 : 0}|${code}|${operatorId}`;

function prefetchFullCall(code, operatorId, recall) {
  if (!TTS_ENABLED) return;
  cachedSynthesis(fullCallKey(code, operatorId, recall), buildAnnouncementText(code, operatorId, recall)).catch((err) =>
    console.error('TTS oldindan tayyorlash xatosi:', err.message)
  );
}

function prefetchCallVoices(code, serviceId) {
  if (!TTS_ENABLED) return;
  for (const op of state.operators) {
    if (op.serviceIds.includes(serviceId)) prefetchFullCall(code, op.id, false);
  }
}

function buildAzureSsml(text) {
  return (
    `<speak version='1.0' xml:lang='uz-UZ'>` +
    `<voice xml:lang='uz-UZ' name='${AZURE_SPEECH_VOICE}'>${xmlEscape(text)}</voice></speak>`
  );
}

async function synthesize(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const isLynx = TTS_PROVIDER === 'lynx';
    const r = await fetch(isLynx ? LYNX_TTS_ENDPOINT : AZURE_SPEECH_ENDPOINT, isLynx
      ? {
          method: 'POST',
          headers: { Authorization: `Bearer ${LYNX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice: LYNX_TTS_VOICE,
            language: LYNX_TTS_LANGUAGE,
            expressiveness: LYNX_TTS_EXPRESSIVENESS,
            ai_normalize: false,
            enhance: false,
          }),
          signal: controller.signal,
        }
      : {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
            'User-Agent': 'bank-navbat',
          },
          body: buildAzureSsml(text),
          signal: controller.signal,
        });
    if (!r.ok) throw new Error(`${isLynx ? 'Lynx' : 'Azure'} TTS ${r.status}`);
    if (isLynx) lynxServedVoice = r.headers.get('x-lynx-voice') || lynxServedVoice;
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function ttsHandler(res, url) {
  const send = (status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  // GET /api/tts with no parameters reports the setup (booleans only, never the key) so a
  // missing/misnamed environment variable can be spotted without server logs.
  if (!url.searchParams.has('code') && !url.searchParams.has('op') && !url.searchParams.has('part')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(
      JSON.stringify({
        enabled: TTS_ENABLED,
        provider: TTS_PROVIDER || null,
        cloudVoiceOn: CLOUD_VOICE_ON,
        hasLynxKey: Boolean(LYNX_API_KEY),
        hasAzureKey: Boolean(AZURE_SPEECH_KEY),
        hasRegion: Boolean(AZURE_SPEECH_REGION),
        hasEndpointOverride: Boolean(process.env.AZURE_SPEECH_ENDPOINT),
        voice: TTS_PROVIDER === 'lynx' ? LYNX_TTS_VOICE : AZURE_SPEECH_VOICE,
        language: TTS_PROVIDER === 'lynx' ? LYNX_TTS_LANGUAGE : 'uz-UZ',
        expressiveness: TTS_PROVIDER === 'lynx' ? LYNX_TTS_EXPRESSIVENESS : null,
        lynxServedVoice,
      })
    );
  }
  if (!TTS_ENABLED) return send(503, 'TTS sozlanmagan');
  const part = url.searchParams.get('part') || '';
  const code = url.searchParams.get('code') || '';
  const op = url.searchParams.get('op') || '';
  const operatorParam = url.searchParams.get('operator') || '';
  const number = Number(url.searchParams.get('number') || '');
  const recall = url.searchParams.get('recall') === '1';
  const operatorId = Number(operatorParam || ((op.match(/\d+/) || [])[0]) || (/valyuta/i.test(op) ? 7 : 0));
  if (part === 'ticket' || part === 'operator' || part === 'number' || part === 'clip') {
    const clipKey = url.searchParams.get('key') || '';
    const clipText = part === 'clip' ? bundledClipText(clipKey) : null;
    const valid =
      part === 'ticket'
        ? /^[A-G]\d{3,4}$/.test(code)
        : part === 'operator'
          ? Number.isInteger(operatorId) && operatorId >= 1 && operatorId <= 7
          : part === 'number'
            ? Number.isInteger(number) && number >= 1 && number <= 99
            : clipText !== null;
    if (!valid) return send(400, 'Notoʻgʻri parametr');
    try {
      const cacheKey = part === 'ticket'
        ? ticketPartKey(code, recall)
        : part === 'operator'
          ? operatorPartKey(operatorId)
          : part === 'number'
            ? numberPartKey(number)
            : `${TTS_PROVIDER}|clip|${clipKey}`;
      const text = part === 'ticket'
        ? buildTicketPartText(code, recall)
        : part === 'operator'
          ? buildOperatorPartText(operatorId)
          : part === 'number'
            ? buildNumberPartText(number)
            : clipText;
      const audio = await cachedSynthesis(
        cacheKey,
        text
      );
      if (!audio) return send(429, 'Juda koʻp soʻrov');
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Cache-Control': 'private, max-age=3600',
      });
      return res.end(audio);
    } catch (err) {
      console.error('TTS xatosi:', err.message);
      return send(502, 'TTS xatosi');
    }
  }
  if (!/^[A-G]\d{3,4}$/.test(code) || !Number.isInteger(operatorId) || operatorId < 1 || operatorId > 7) {
    return send(400, 'Notoʻgʻri parametr');
  }

  let audio;
  try {
    audio = await cachedSynthesis(fullCallKey(code, operatorId, recall), buildAnnouncementText(code, operatorId, recall));
  } catch (err) {
    console.error('TTS xatosi:', err.message);
    return send(502, 'TTS xatosi');
  }
  if (!audio) return send(429, 'Juda koʻp soʻrov');
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': audio.length,
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(audio);
}

// ---------------------------------------------------------------------------
// Idempotent POSTs
// ---------------------------------------------------------------------------
// A client that times out can't tell "never arrived" from "done, reply lost", so it
// retries with the same X-Request-Id. Running a given id once and replaying the saved
// answer keeps a retried "call next" from skipping a customer or a retried ticket
// request from issuing two numbers. Failed attempts aren't remembered.
const IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const IDEMPOTENCY_MAX = 2000;
/** @type {Map<string, {at: number, promise: Promise<any>}>} */
const idempotentRuns = new Map();

function runOnce(key, fn) {
  if (!key) return Promise.resolve().then(fn);
  const hit = idempotentRuns.get(key);
  if (hit) return hit.promise;
  const promise = Promise.resolve().then(fn);
  idempotentRuns.set(key, { at: Date.now(), promise });
  promise.catch(() => idempotentRuns.delete(key));
  while (idempotentRuns.size > IDEMPOTENCY_MAX) {
    idempotentRuns.delete(idempotentRuns.keys().next().value);
  }
  return promise;
}

setInterval(() => {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, v] of idempotentRuns) if (v.at < cutoff) idempotentRuns.delete(key);
}, 30 * 1000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/events') return sseHandler(req, res);
    if (req.method === 'GET' && pathname === '/api/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(viewJson());
    }
    if (req.method === 'GET' && pathname === '/api/tts') return ttsHandler(res, url);
    if (req.method === 'GET' && pathname === '/api/qr') {
      return sendJson(res, 200, {
        ok: true,
        url: KIOSK_URL,
        dataUrl: qrDataUrl,
        addresses: lanAddresses(),
        port: PORT,
      });
    }

    const apiKey = `${req.method} ${pathname}`;
    if (API_HANDLERS[apiKey]) {
      const body = await readJsonBody(req);
      const requestId = String(req.headers['x-request-id'] || '').slice(0, 80);
      const result = await runOnce(requestId && `${apiKey}|${requestId}`, () => API_HANDLERS[apiKey](body));
      return sendJson(res, 200, result);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'Bunday amal yoʻq' });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'Server xatosi' });
    if (status >= 500) console.error(err);
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

load();

// Midnight rollover: an exact-ish timer plus a 60s safety net.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    if (checkRollover()) commit();
    scheduleMidnight();
  }, next - now);
}
scheduleMidnight();
setInterval(() => {
  if (checkRollover()) commit();
}, 60 * 1000);

// Free hosting plans (e.g. Render's free tier) suspend the service after
// ~15 minutes with no *inbound* HTTP traffic — a plain setInterval inside the
// process doesn't count, since it generates no external request. Making a
// real request to our own public URL does count as inbound traffic and keeps
// the host from ever seeing 15 idle minutes, at no cost and no separate
// uptime service. Only runs when RENDER_EXTERNAL_URL is actually set (i.e.
// really running on Render), so local/dev runs never self-ping.
if (process.env.RENDER_EXTERNAL_URL) {
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // comfortably under the ~15 min sleep threshold
  const selfPingUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/api/qr`;
  setInterval(() => {
    fetch(selfPingUrl).catch(() => {
      /* a missed ping just means we skip resetting the idle clock this time */
    });
  }, SELF_PING_INTERVAL_MS);
}

// Node closes idle keep-alive sockets after 5s by default. Render/Cloudflare reuse
// upstream connections for longer, so a request sent just as Node closes the socket
// fails with a reset ("server dan uzildi"). Keep sockets open longer than the proxy does.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

server.listen(PORT, () => {
  const addrs = ['localhost', ...lanAddresses()];
  console.log('\n  Bank navbat tizimi ishga tushdi\n');
  for (const a of addrs) {
    console.log(`    Bosh sahifa   : http://${a}:${PORT}/`);
    console.log(`    Mijoz kioski  : http://${a}:${PORT}/kiosk`);
    console.log(`    TV ekrani     : http://${a}:${PORT}/tv`);
    console.log(`    Operator panel: http://${a}:${PORT}/staff`);
    console.log(`    QR plakat     : http://${a}:${PORT}/qr`);
    console.log(`    Admin panel   : http://${a}:${PORT}/admin`);
    console.log('');
  }
  console.log(`  QR kod manzili : ${KIOSK_URL}`);
  console.log('  (boshqa manzil uchun: PUBLIC_URL=http://host:port npm start)\n');
  console.log('  Toʻxtatish: Ctrl+C\n');
});
