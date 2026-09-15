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
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');
const BRANCH_ADDRESS = "Toshkent shahri, Ko'kcha Darvoza, 489B";
const BRANCH_PHONE = process.env.BRANCH_PHONE || '1284';

// ---- ASCII-safe decorative helpers (Unicode box-drawing chars are risky —
// thermal codepages already mangle non-ASCII like "oʻ", so stick to +,-,|,*) ----
const BOX_WIDTH = 46; // ichki kenglik; +---+  chegara bilan jami 48 ustunga teng

function boxTop(printer) {
  printer.println('+' + '-'.repeat(BOX_WIDTH) + '+');
}

function boxBottom(printer) {
  printer.println('+' + '-'.repeat(BOX_WIDTH) + '+');
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

function boxRow(printer, label, value) {
  const text = ` ${asciiSafe(label)}: ${asciiSafe(value)}`;
  const line = text.length > BOX_WIDTH ? text.slice(0, BOX_WIDTH) : text.padEnd(BOX_WIDTH, ' ');
  printer.println('|' + line + '|');
}

function starRule(printer) {
  printer.println('* '.repeat(Math.floor(BOX_WIDTH / 2)).trim());
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
    printer.bold(true);
    printer.println('"DAVR BANK" XATB');
    printer.bold(false);
    printer.println('Uchtepa filiali');
    printer.println('Xush kelibsiz!');
    printer.newLine();

    // ---- Ticket number: the focal point — big & bold, plain (no invert) ----
    printer.println('Navbat raqami');
    printer.bold(true);
    printer.setTextSize(1, 1); // yarim: (3,2) edi -> (1,1)
    printer.println(String(number));
    printer.setTextSize(0, 0);
    printer.bold(false);

    // ---- Service: its own big, bold section — not buried in the card ----
    printer.alignCenter();
    starRule(printer);
    printer.println('Xizmat turi');
    printer.bold(true);
    printer.println(asciiSafe(service || '-').toUpperCase()); // yarim: 2x edi -> oddiy
    printer.bold(false);

    // ---- Details: boxed card instead of loose lines ----
    starRule(printer);

    printer.alignLeft();
    boxTop(printer);
    boxRow(printer, 'Sana', `${date || ''}  ${time || ''}`);
    boxRow(printer, 'Navbatdagi tartibingiz', position != null ? `${position}-o'rin` : '-');
    boxRow(printer, 'Sizdan oldin', ahead != null ? `${ahead} kishi` : '-');
    boxRow(printer, 'Taxminiy kutish', etaMin != null ? `~${etaMin} daqiqa` : '-');
    boxBottom(printer);
    printer.alignCenter();

    // ---- Branch contact info ----
    printer.println(BRANCH_ADDRESS);
    printer.bold(true);
    printer.println(`Yagona axborot xizmati: ${BRANCH_PHONE}`);
    printer.bold(false);

    starRule(printer);

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
      execSync(`copy /b "${tempFile}" "\\\\localhost\\${PRINTER_SHARE_NAME}"`, {
        shell: 'cmd.exe',
        timeout: COPY_TIMEOUT_MS,
      });
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

app.get('/health', (req, res) => {
  res.json({ ok: true, printer: PRINTER_SHARE_NAME });
});

app.listen(9100, () => {
  console.log(`Print-servis 9100-portda ishga tushdi (printer share: ${PRINTER_SHARE_NAME})`);
});
