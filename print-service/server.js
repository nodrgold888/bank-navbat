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
const KIOSK_URL = process.env.KIOSK_URL || 'https://bank-navbat.onrender.com/kiosk';

// ---- ASCII-safe decorative helpers (Unicode box-drawing chars are risky —
// thermal codepages already mangle non-ASCII like "oʻ", so stick to +,-,|,*) ----
const BOX_WIDTH = 46; // ichki kenglik; +---+  chegara bilan jami 48 ustunga teng

function boxTop(printer) {
  printer.println('+' + '-'.repeat(BOX_WIDTH) + '+');
}

function boxBottom(printer) {
  printer.println('+' + '-'.repeat(BOX_WIDTH) + '+');
}

function boxRow(printer, label, value) {
  const text = ` ${label}: ${value}`;
  const line = text.length > BOX_WIDTH ? text.slice(0, BOX_WIDTH) : text.padEnd(BOX_WIDTH, ' ');
  printer.println('|' + line + '|');
}

function starRule(printer) {
  printer.println('* '.repeat(Math.floor(BOX_WIDTH / 2)).trim());
}

app.post('/print', async (req, res) => {
  try {
    const { service, number, ahead, date, time } = req.body || {};

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
        printer.newLine();
      } catch (e) {
        console.warn('  -> logo chop etilmadi:', e.message);
      }
    }

    // ---- Header ----
    printer.bold(true);
    printer.setTextSize(1, 1); // 2x — bank nomi
    printer.println('"DAVR BANK" XATB');
    printer.setTextSize(0, 0);
    printer.bold(false);
    printer.println('Uchtepa filiali');
    printer.newLine();
    printer.println('Xush kelibsiz!');
    printer.newLine();

    // ---- Ticket number: the focal point — big & bold, plain (no invert) ----
    printer.println('Navbat raqami');
    printer.bold(true);
    printer.setTextSize(3, 2);
    printer.println(String(number));
    printer.setTextSize(0, 0);
    printer.bold(false);
    printer.newLine();

    // ---- Details: boxed card instead of loose lines ----
    printer.alignCenter();
    starRule(printer);
    printer.newLine();

    printer.alignLeft();
    boxTop(printer);
    boxRow(printer, 'Xizmat', service || '-');
    boxRow(printer, 'Sana', `${date || ''}  ${time || ''}`);
    boxRow(printer, 'Sizdan oldin', ahead != null ? `${ahead} kishi` : '-');
    boxBottom(printer);
    printer.alignCenter();
    printer.newLine();

    // ---- QR: scan to reopen the kiosk / check the queue from your phone ----
    try {
      printer.bold(true);
      printer.println('NAVBATNI TELEFONDA KUZATING');
      printer.bold(false);
      printer.newLine();
      printer.printQR(KIOSK_URL, { cellSize: 6, correction: 'M' });
      printer.newLine();
      printer.println('QR-kodni skanerlang');
      printer.newLine();
    } catch (e) {
      console.warn('  -> QR chop etilmadi:', e.message);
    }

    starRule(printer);
    printer.newLine();

    // ---- Footer: inverted black bar, like the "thank you" line on the sample ----
    printer.bold(true);
    printer.invert(true);
    printer.println('   KUTGANINGIZ UCHUN RAHMAT!   ');
    printer.invert(false);
    printer.bold(false);
    printer.newLine();
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
