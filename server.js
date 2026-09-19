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

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

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
    subtitle: 'Isteʼmol, avtokredit, ipoteka, mikroqarz',
    prefix: 'A',
    icon: '💳',
    color: '#6366f1',
  },
  {
    id: 'depozitlar',
    name: 'Depozitlar',
    subtitle:
      "Omonat va jamg'arma hisoblari ochish, mablag'larni saqlash, chet davlatlarga safar uchun bank ma'lumotnomasini rasmiylashtirish",
    prefix: 'B',
    icon: '💰',
    color: '#16a34a',
  },
  {
    id: 'tolovlar',
    name: 'Toʻlovlar va pul oʻtkazmalari',
    subtitle:
      "Kontrakt toʻlovlari, kommunal xizmatlar haqi, jarima toʻlovlari va pul oʻtkazmalarini amalga oshirish",
    prefix: 'C',
    icon: '💸',
    color: '#d97706',
  },
  {
    id: 'kartalar',
    name: 'Bank kartalari',
    subtitle:
      "Visa/Uzcard/Humo: yangi karta ochish, qayta chiqarish (yo'qolgan/muddati tugagan), bloklash, PIN almashtirish, karta biriktirish",
    prefix: 'D',
    icon: '💳',
    color: '#0891b2',
  },
  {
    id: 'terminalar',
    name: 'Terminalar bilan ishlash',
    subtitle:
      "POS-terminallarni ulash va sozlash, texnik xizmat koʻrsatish, ishlamay qolgan terminallar boʻyicha murojaatlar",
    prefix: 'E',
    icon: '🖥️',
    color: '#0d9488',
  },
  {
    id: 'escrow',
    name: 'Escrow xizmati',
    subtitle: 'Uy 🏠 va avtomashina 🚗 oldi-sotdi bitimlari',
    prefix: 'F',
    icon: '🤝',
    color: '#7c3aed',
  },
  {
    id: 'valyuta',
    name: 'Valyuta ayirboshlash',
    subtitle: "Dollar, yevro va boshqa valyutalarni so'mga almashtirish",
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
    if (c) svcId = c.serviceId;
  }
  const had = Boolean(op.currentTicketId);
  completeCurrent(op, 'no_show');

  // Continue from the same queue; fall back to auto if it is now empty.
  let next = assignNext(op, svcId);
  if (!next && svcId) next = assignNext(op, null);
  return { skipped: had, called: next };
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
  const waitingList = waitingSorted.slice(0, 8).map(mapWaiting);
  // Full waiting queue for the admin cancel UI — capped for payload size.
  const fullQueue = waitingSorted.slice(0, 120).map(mapWaiting);

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
    businessDate: state.businessDate,
    services,
    board,
    waitingList,
    queue: fullQueue,
    operators,
    lastCall,
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/events') return sseHandler(req, res);
    if (req.method === 'GET' && pathname === '/api/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(viewJson());
    }
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
      return sendJson(res, 200, await API_HANDLERS[apiKey](body));
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
