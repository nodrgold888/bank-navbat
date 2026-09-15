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

    // ---- Header ----
    printer.alignCenter();
    printer.setTypeFontA();
    printer.bold(true);
    printer.setTextSize(1, 1); // 2x — bank nomi
    printer.println('DAVR BANK');
    printer.setTextSize(0, 0);
    printer.bold(false);
    printer.println('Uchtepa tumani filiali');
    printer.newLine();
    printer.drawLine('=');

    // ---- Service name ----
    printer.newLine();
    printer.bold(true);
    printer.println((service || '').toUpperCase());
    printer.bold(false);
    printer.newLine();

    // ---- Ticket number: big, bold, inverted (black block) so it pops ----
    printer.println('SIZNING RAQAMINGIZ');
    printer.newLine();
    printer.bold(true);
    printer.invert(true);
    printer.setTextSize(4, 3); // juda katta shrift
    printer.println(` ${number} `);
    printer.setTextSize(0, 0);
    printer.invert(false);
    printer.bold(false);
    printer.newLine();

    // ---- Info block ----
    printer.drawLine('-');
    printer.alignLeft();
    printer.bold(true);
    printer.leftRight('Sizdan oldingilar', ahead != null ? String(ahead) : '-');
    printer.bold(false);
    printer.leftRight('Sana', date || '-');
    printer.leftRight('Vaqt', time || '-');
    printer.drawLine('-');

    // ---- Footer ----
    printer.newLine();
    printer.alignCenter();
    printer.println('Iltimos, navbatingizni kuting.');
    printer.newLine();
    printer.bold(true);
    printer.setTextSize(0, 1); // biroz kengroq
    printer.println('RAHMAT!');
    printer.setTextSize(0, 0);
    printer.bold(false);
    printer.newLine();
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
