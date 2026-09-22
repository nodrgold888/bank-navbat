/* ==========================================================================
   Shared launcher logic for the desktop .exe wrappers (staff/admin/tv).

   Each wrapper is nothing but a native window opener: the real app is the
   Node server (server.js) running somewhere on the network. These .exe
   files just point a browser at one specific panel of it, so operators,
   admins and the TV don't need to type a URL by hand.

   Server address comes from a "davrbank-server.txt" file kept next to the
   .exe (created with a sensible default on first run) — edit it once per
   PC if the server isn't running on that same machine.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_NAME = 'davrbank-server.txt';
const DEFAULT_SERVER = 'http://localhost:4123';

// process.pkg is only set inside a pkg-built binary; alongside the exe is
// where a real person can find and edit the config file. Outside of pkg
// (plain `node desktop/open.js` while developing) fall back to this folder.
function exeDir() {
  return process.pkg ? path.dirname(process.execPath) : __dirname;
}

function readServerUrl() {
  const configPath = path.join(exeDir(), CONFIG_NAME);
  try {
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (raw) return raw.replace(/\/+$/, '');
  } catch (e) {
    // No config yet — create one with the default so it's easy to find
    // and edit next to the .exe.
    try {
      fs.writeFileSync(
        configPath,
        DEFAULT_SERVER +
          '\r\n\r\n' +
          '# Davr Bank navbat tizimi qaysi manzilda ishlayotgan boʻlsa,\r\n' +
          '# shu yerga yozing (masalan: http://192.168.1.10:4123).\r\n' +
          '# Birinchi qatordan boshqa hammasi izoh, oʻqilmaydi.\r\n',
        'utf8'
      );
    } catch (e2) {
      /* read-only folder — just use the default silently */
    }
  }
  return DEFAULT_SERVER;
}

function openUrl(url, kiosk) {
  if (process.platform === 'win32') {
    if (kiosk) {
      // Try Edge, then Chrome, in kiosk (fullscreen, no browser chrome) mode
      // — this is what the TV should run unattended. Fall back to whatever
      // the OS considers the default browser, in a normal window, if
      // neither is installed.
      const candidates = [
        ['msedge', ['--kiosk', url, '--edge-kiosk-type=fullscreen', '--no-first-run']],
        ['chrome', ['--kiosk', url, '--no-first-run']],
      ];
      tryCandidates(candidates, () => openUrl(url, false));
      return;
    }
    execFile('cmd', ['/c', 'start', '', url]);
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', [url]);
    return;
  }
  execFile('xdg-open', [url]);
}

function tryCandidates(candidates, fallback) {
  if (!candidates.length) return fallback();
  const [cmd, args] = candidates[0];
  execFile(cmd, args, (err) => {
    if (err) tryCandidates(candidates.slice(1), fallback);
  });
}

/**
 * @param {string} panelPath  e.g. '/staff', '/admin', '/tv'
 * @param {boolean} [kiosk]   fullscreen, chrome-less window (TV only)
 */
function launch(panelPath, kiosk) {
  const server = readServerUrl();
  openUrl(server + panelPath, Boolean(kiosk));
}

module.exports = { launch };
