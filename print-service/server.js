const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
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

// ---- ASCII-safe decorative helpers (Unicode box-drawing chars are risky —
// thermal codepages already mangle non-ASCII like "oʻ", so stick to +,-,|,*) ----
const BOX_WIDTH = 46; // detail rows wrap/pad to this width

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

// Plain "Label: value" row — used to be framed in a "|...|" box, but that
// border was 2 extra lines of pure "+---+" paper with no information of its
// own, so it's gone; the same 4 fields print in the same order either way.
function boxRow(printer, label, value) {
  const text = `${asciiSafe(label)}: ${asciiSafe(value)}`;
  const line = text.length > BOX_WIDTH ? text.slice(0, BOX_WIDTH) : text;
  printer.println(line);
}

app.post('/print', async (req, res) => {
  try {
    const { service, number, ahead, date, time, position, etaMin } = req.body || {};

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

    // ---- Header ----
    // (no trailing blank line here — every removed blank/rule/border line
    // below is pure whitespace paper, not information, so trimming them
    // shortens the receipt without dropping a single field from it.)
    printer.bold(true);
    printer.println('"DAVR BANK" XATB');
    printer.bold(false);
    printer.println('Uchtepa filiali - Xush kelibsiz!');

    // ---- Ticket number: the focal point — big & bold, plain (no invert) ----
    printer.println('Navbat raqami');
    printer.bold(true);
    printer.setTextSize(2, 2);
    printer.println(String(number));
    printer.setTextSize(0, 0);
    printer.bold(false);

    // ---- Service: its own big, bold section — not buried in the card ----
    printer.alignCenter();
    printer.println('Xizmat turi');
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(asciiSafe(service || '-').toUpperCase());
    printer.setTextSize(0, 0);
    printer.bold(false);

    // ---- Details: same 4 fields as before, without the decorative box
    // border (2 lines of pure "+---+" framing, no information of its own) ----
    // and without a separator rule — the font-size step-down from the
    // service name already marks the transition clearly enough.
    printer.alignLeft();
    boxRow(printer, 'Sana', `${date || ''}  ${time || ''}`);
    boxRow(printer, 'Navbatdagi tartibingiz', position != null ? `${position}-o'rin` : '-');
    boxRow(printer, 'Sizdan oldin', ahead != null ? `${ahead} kishi` : '-');
    boxRow(printer, 'Taxminiy kutish', etaMin != null ? `~${etaMin} daqiqa` : '-');
    printer.alignCenter();

    // ---- Branch contact info ----
    printer.println(BRANCH_ADDRESS);
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

    const tempFile = path.join(os.tmpdir(), `receipt_${Date.now()}.bin`);
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
