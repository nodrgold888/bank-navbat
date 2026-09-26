#!/usr/bin/env node
// Minimal chromium-cli-style REPL driver for bank-navbat, for environments
// where the real chromium-cli tool isn't installed. Reads newline-delimited
// commands from stdin, drives one persistent headless Chromium page, and
// writes screenshots into ./screenshots/ next to this file.
//
// Commands (one per line):
//   nav <url>                    navigate the page
//   wait-for text=<substring>    wait until page text contains <substring>
//   wait-for <css-selector>      wait until a selector is visible
//   screenshot [name]            save screenshots/<name|NNN>.png
//   click <css-selector>
//   fill <css-selector> <value>
//   press <key>                  e.g. Enter
//   eval <js-expression>         runs in page context, prints the result
//   post <path> <json>           fetch(path, {method:'POST', body: json}) from
//                                 inside the page's origin; prints the response
//   console --errors             print captured console.error / pageerror lines
//   sleep <ms>
//   quit
//
// Usage:
//   NODE_PATH=/opt/node22/lib/node_modules node driver.mjs <<'EOF'
//   nav http://localhost:3000/tv
//   wait-for text=Operatorlar
//   screenshot tv-boot
//   EOF

import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Playwright isn't a project dependency (this is agent tooling, not app
// code) — it's installed globally in this container. Import it by its
// absolute path so this driver doesn't depend on NODE_PATH being set,
// which ESM resolution ignores anyway (unlike CJS require).
const PLAYWRIGHT_ENTRY = process.env.PLAYWRIGHT_MJS || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT_ENTRY);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'screenshots');

let shotCounter = 0;
const consoleLog = [];

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleLog.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', (err) => consoleLog.push('[pageerror] ' + err.message));

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [cmd, ...rest] = line.split(' ');
    const argStr = rest.join(' ');
    try {
      await runCommand(page, cmd, argStr);
    } catch (err) {
      console.error('ERROR running "' + line + '": ' + err.message);
    }
  }

  await browser.close();
}

async function runCommand(page, cmd, argStr) {
  switch (cmd) {
    case 'nav': {
      await page.goto(argStr, { waitUntil: 'load', timeout: 30000 });
      console.log('nav ok:', argStr);
      break;
    }
    case 'wait-for': {
      if (argStr.startsWith('text=')) {
        // innerText reflects CSS text-transform (this app upper-cases most
        // section headings), so match case-insensitively or "Operatorlar"
        // never matches the rendered "OPERATORLAR".
        const needle = argStr.slice('text='.length).toLowerCase();
        await page.waitForFunction(
          (n) => document.body && document.body.innerText.toLowerCase().includes(n),
          needle,
          { timeout: 15000 }
        );
      } else {
        await page.waitForSelector(argStr, { timeout: 15000, state: 'visible' });
      }
      console.log('wait-for ok:', argStr);
      break;
    }
    case 'screenshot': {
      const name = argStr || String(++shotCounter).padStart(3, '0');
      const file = path.join(SHOT_DIR, name.endsWith('.png') ? name : name + '.png');
      await page.screenshot({ path: file });
      console.log('screenshot ->', file);
      break;
    }
    case 'click': {
      await page.click(argStr, { timeout: 10000 });
      console.log('click ok:', argStr);
      break;
    }
    case 'fill': {
      const sp = argStr.indexOf(' ');
      const sel = sp === -1 ? argStr : argStr.slice(0, sp);
      const val = sp === -1 ? '' : argStr.slice(sp + 1);
      await page.fill(sel, val, { timeout: 10000 });
      console.log('fill ok:', sel);
      break;
    }
    case 'press': {
      await page.keyboard.press(argStr);
      console.log('press ok:', argStr);
      break;
    }
    case 'eval': {
      const result = await page.evaluate((expr) => eval(expr), argStr);
      console.log('eval ->', JSON.stringify(result));
      break;
    }
    case 'post': {
      const sp = argStr.indexOf(' ');
      const urlPath = sp === -1 ? argStr : argStr.slice(0, sp);
      const bodyJson = sp === -1 ? '{}' : argStr.slice(sp + 1);
      const result = await page.evaluate(
        async ({ urlPath, bodyJson }) => {
          const res = await fetch(urlPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyJson,
          });
          return { status: res.status, body: await res.text() };
        },
        { urlPath, bodyJson }
      );
      console.log('post', urlPath, '->', result.status, result.body);
      break;
    }
    case 'console': {
      if (argStr.includes('--errors')) {
        if (consoleLog.length === 0) console.log('console: no errors captured');
        else consoleLog.forEach((l) => console.log(l));
      }
      break;
    }
    case 'sleep': {
      await new Promise((r) => setTimeout(r, Number(argStr) || 0));
      break;
    }
    case 'quit':
    case 'exit': {
      process.exit(0);
      break;
    }
    default:
      console.error('unknown command:', cmd);
  }
}

main();
