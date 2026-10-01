const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');

const app = express();

// Kiosk sahifasi https://bank-navbat.onrender.com dan yuklanadi, bu servis esa
// shu kompyuterda http://localhost:9100 da ishlaydi. Chrome'ning "Private
// Network Access" siyosati https sahifadan lokal manzilga so'rov ketganda
// qo'shimcha preflight talab qiladi — shu headerlarsiz so'rov jimgina bloklanishi
// mumkin, shuning uchun avval qo'yiladi.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString('uz-UZ')}] ${req.method} ${req.path}`);
  next();
});

const PRINTER_SHARE_NAME = process.env.PRINTER_SHARE_NAME || 'XP-80C'; // Windows'da share qilingan printer nomi
const COPY_TIMEOUT_MS = 8000; // printer javob bermasa, servisni ilib qo'ymaslik uchun
const PRINT_RETRY_COUNT = 2; // vaqtinchalik xatolarda (spooler band, printer uyg'onmoqda) qayta urinish soni
const PRINT_RETRY_DELAY_MS = 1000;
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');
const BRANCH_ADDRESS = "Toshkent shahri, Uchtepa tumani, Ko'kcha Darvoza, 489B";
const BRANCH_PHONE = process.env.BRANCH_PHONE || '1284';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows share'ga nusxalashda vaqtinchalik xatolar (spooler band, printer
// uyqudan uyg'onmoqda) tez-tez uchraydi — bir necha marta urinib ko'ramiz,
// har safar bo'sh joydan boshlamaymiz.
async function copyToShare(tempFile) {
  const cmd = `copy /b "${tempFile}" "\\\\localhost\\${PRINTER_SHARE_NAME}"`;
  let lastErr;
  for (let attempt = 1; attempt <= PRINT_RETRY_COUNT + 1; attempt += 1) {
    try {
      execSync(cmd, { shell: 'cmd.exe', timeout: COPY_TIMEOUT_MS });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  -> nusxalash urinishi ${attempt} muvaffaqiyatsiz: ${err.message}`);
      if (attempt <= PRINT_RETRY_COUNT) {
        await sleep(PRINT_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

// Printer codepage can't encode the Uzbek modifier-letter apostrophe (ʻ/ʼ) or
// curly quotes — node-thermal-printer silently drops in "?" per character
// when that happens (confirmed: "bo'limi" -> "bo?limi" on real paper), so
// normalize to plain ASCII before anything reaches the printer.
function asciiSafe(text) {
  if (text == null) return text;
  return String(text)
    .replace(/[ʻʼ‘’ʾʿ]/g, "'")
    .replace(/[“”]/g, '"');
}

// 48 columns at normal size, 24 at double width (setTextSize(1, 1)).
const SERVICE_LINE_CHARS = 24;

function wrapWords(text, width) {
  const lines = [];
  let line = '';
  String(text)
    .split(/\s+/)
    .filter(Boolean)
    .forEach((word) => {
      let w = word;
      while (w.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if ((line + ' ' + w).length <= width) line += ' ' + w;
      else {
        lines.push(line);
        line = w;
      }
    });
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

app.post('/print', async (req, res) => {
  try {
    const { service, number, ahead, date, day, time, position, etaMin } = req.body || {};

    if (!number) {
      return res.status(400).json({ error: "'number' (chek raqami) majburiy" });
    }

    let printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      width: 48,
      // interface va driver YO'Q — buferni o'zimiz yozamiz va Windows share orqali yuboramiz
    });

    printer.setTypeFontA();
    printer.alignCenter();

    // ---- Logo ----
    if (fs.existsSync(LOGO_PATH)) {
      try {
        await printer.printImage(LOGO_PATH);
      } catch (e) {
        console.warn('  -> logo chop etilmadi:', e.message);
      }
    }

    // Compact layout: every customer-facing detail is retained, but related
    // fields share a line and the receipt logo is smaller to save paper.
    printer.bold(true);
    printer.println('"DAVR BANK" XATB | Uchtepa filiali');
    printer.bold(false);
    printer.println('Xush kelibsiz!');

    // ---- Ticket number: the focal point — big & bold, plain (no invert) ----
    printer.println('Navbat raqami');
    printer.bold(true);
    printer.setTextSize(2, 2);
    printer.println(String(number));
    printer.setTextSize(0, 0);
    printer.bold(false);

    // ---- Service: bold and readable, without a separate label line ----
    printer.alignCenter();
    printer.println('TANLANGAN XIZMAT');
    printer.bold(true);
    printer.setTextSize(1, 1);
    // Double-size text fits only half the columns; break at word boundaries so a
    // long name never splits mid-word.
    wrapWords(asciiSafe(service || '-').toUpperCase(), SERVICE_LINE_CHARS).forEach((line) => {
      printer.println(line);
    });
    printer.setTextSize(0, 0);
    printer.bold(false);

    // Date, weekday and time; then queue position and wait estimate. The
    // values are unchanged, only grouped to make the receipt about half as long.
    printer.println(`${date || '-'} | ${day || '-'} | ${time || '-'}`);
    printer.bold(true);
    printer.println(`Navbatdagi o'rningiz: ${position != null ? `${position}-o'rin` : '-'}`);
    printer.println(`Sizdan oldingilar: ${ahead != null ? ahead : '-'}`);
    printer.bold(false);
    printer.println(`Taxminiy kutish: ${etaMin != null ? `~${etaMin} daqiqa` : '-'}`);
    printer.alignCenter();

    // ---- Branch contact info ----
    printer.println('Toshkent sh., Uchtepa tumani');
    printer.println("Ko'kcha Darvoza, 489B");
    printer.bold(true);
    printer.println(`Yagona axborot xizmati: ${BRANCH_PHONE}`);
    printer.bold(false);

    // ---- Footer: inverted black bar, like the "thank you" line on the sample ----
    printer.bold(true);
    printer.invert(true);
    printer.println('   KUTGANINGIZ UCHUN RAHMAT!   ');
    printer.invert(false);
    printer.bold(false);
    printer.cut();

    const buffer = printer.getBuffer();

    // Date.now() alone can collide if two /print requests land in the same
    // millisecond (e.g. a kiosk client retry firing while the first attempt
    // is still being processed) — one request's write/unlink could then
    // clobber the other's temp file mid-copy. randomUUID() makes each
    // request's file unique regardless of timing.
    const tempFile = path.join(os.tmpdir(), `receipt_${Date.now()}_${crypto.randomUUID()}.bin`);
    fs.writeFileSync(tempFile, buffer);

    try {
      await copyToShare(tempFile);
    } finally {
      fs.unlinkSync(tempFile);
    }

    console.log(`  -> chop etildi: ${service || ''} #${number}`);
    res.json({ success: true });
  } catch (err) {
    console.error('  -> XATOLIK:', err.message);
    const timedOut = err.killed || err.signal === 'SIGTERM';
    res.status(500).json({
      error: timedOut
        ? `Printer (${PRINTER_SHARE_NAME}) javob bermadi — ulanishni tekshiring`
        : err.message,
    });
  }
});

// Shunchaki "servis tirik"ligini emas, printer share'i haqiqatan ham
// ko'rinayotganini tekshiradi — shu tufayli kiosk chop etishdan oldin
// muammoni oldindan bila oladi.
app.get('/health', async (req, res) => {
  try {
    execSync(`dir "\\\\localhost\\${PRINTER_SHARE_NAME}"`, { shell: 'cmd.exe', timeout: 3000 });
    res.json({ ok: true, printer: PRINTER_SHARE_NAME });
  } catch (err) {
    res.status(503).json({ ok: false, printer: PRINTER_SHARE_NAME, error: err.message });
  }
});

// Servis nssm orqali kuzatuvsiz Windows xizmati sifatida ishlaydi — kutilmagan
// xato butun jarayonni yiqitib qo'ymasin, shunchaki logga yozilsin.
process.on('uncaughtException', (err) => {
  console.error('  -> KUTILMAGAN XATO:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('  -> KUTILMAGAN PROMISE XATOSI:', err);
});

app.listen(9100, () => {
  console.log(`Print-servis 9100-portda ishga tushdi (printer share: ${PRINTER_SHARE_NAME})`);
});
