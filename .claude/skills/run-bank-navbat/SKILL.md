---
name: run-bank-navbat
description: Build, run, and drive the bank-navbat queue-ticketing app (kiosk, TV display, staff panel, admin dashboard). Use when asked to start bank-navbat, run it, take a screenshot of the kiosk/TV/staff/admin pages, or verify a UI change actually works in the browser.
---

Plain Node.js HTTP server (`server.js`, no framework) serving static
pages under `public/` (`/kiosk-terminal`, `/tv`, `/staff`, `/admin`)
plus a JSON API and an SSE stream (`/events`) for real-time push. It's
a browser-driven web app: start the server, then drive a headless
Chromium against it with the REPL driver at
`.claude/skills/run-bank-navbat/driver.mjs` (this container has no
`chromium-cli` binary, so this driver fills that role — same
nav/wait-for/screenshot loop). All paths below are relative to the
repo root.

## Prerequisites

None beyond Node itself (`>=18`, per `package.json`). Chromium and
Playwright are already provided by this container
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); Playwright's `chromium`
package is installed globally at
`/opt/node22/lib/node_modules/playwright`, which the driver imports by
absolute path (see Gotchas) so nothing extra needs installing.

## Setup

```bash
npm install   # already vendored in this checkout; only needed after a fresh clone
```

No env vars are required. `PORT` defaults to `3000` if you need a
different one (`PORT=4000 npm start`).

## Build

No build step — plain server + static HTML/CSS/JS.

## Run (agent path)

1. Start the server in the background and wait for it to actually serve:

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill   # free the port from any previous run
npm start > /tmp/bn_server.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://localhost:3000/api/state >/dev/null; do sleep 1; done'
```

2. Drive it with the REPL driver — pipe a script to stdin, same shape
   as `chromium-cli`:

```bash
cd .claude/skills/run-bank-navbat
node driver.mjs <<'EOF'
nav http://localhost:3000/tv
wait-for text=Operatorlar
screenshot 01-tv-boot
post /api/ticket {"serviceId":"kreditlash"}
post /api/call-next {"operatorId":1}
sleep 800
screenshot 02-tv-after-call
console --errors
quit
EOF
```

Screenshots land in `.claude/skills/run-bank-navbat/screenshots/`.
This exact script was run to verify this skill: the TV screen showed
operator 1 idle, then updated live (via SSE, no reload) to show the
newly issued and called ticket after the two `post` commands — proof
the real-time queue push actually works end to end.

3. Stop the server when done:

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
```

### Driver commands

| command | what it does |
|---|---|
| `nav <url>` | navigate the page |
| `wait-for text=<substring>` | wait until rendered page text contains `<substring>` (case-insensitive) |
| `wait-for <css-selector>` | wait until a selector is visible |
| `screenshot [name]` | save `screenshots/<name\|NNN>.png` |
| `click <css-selector>` | |
| `fill <css-selector> <value>` | |
| `press <key>` | e.g. `Enter` |
| `eval <js-expression>` | runs in page context, prints the result |
| `post <path> <json>` | `fetch(path, {method:'POST', body: json})` from the page's own origin — the fastest way to drive this app's state (see below) |
| `console --errors` | print captured `console.error` / `pageerror` lines |
| `sleep <ms>` | |
| `quit` | |

### Driving app state directly (covers most real changes)

Almost every PR here touches `server.js`'s state machine or one of the
three pages' rendering of it, not raw DOM interaction — so `post` is
usually the fastest way to exercise a change, faster than clicking
through the kiosk flow:

- `post /api/ticket {"serviceId":"kreditlash"}` — issue a ticket (valid
  service ids: check `GET /api/state` → `services[].id`, e.g.
  `kreditlash`, `depozitlar`, `tolovlar`, `kartalar`, `terminalar`,
  `escrow`, `valyuta`)
- `post /api/call-next {"operatorId":1}` — call the next ticket to
  operator 1 (valid operator ids: `GET /api/state` → `board[].id`)
- `post /api/recall {"operatorId":1}` / `post /api/skip {"operatorId":1}`
- `post /api/reset {}` — wipe the day's state back to empty

Then `nav` to `/tv` (or `/staff`, `/admin`) and `screenshot` — the page
updates live over SSE, no reload needed (`sleep 500`–`800` after a
`post` before the screenshot, to let the push land).

## Run (human path)

```bash
npm start   # -> serves on :3000. Ctrl-C to stop.
```

Open `http://localhost:3000/kiosk-terminal`, `/tv`, `/staff`, or
`/admin` in a real browser. Useless in this headless container —
use the agent path above instead.

## Test

No automated test suite in this repo (manual/Playwright verification
only, via the driver above).

## Gotchas

- **Playwright import needs an absolute path, not `NODE_PATH`.**
  Playwright isn't a dependency of this project (it's agent tooling),
  it's installed globally. `NODE_PATH` only affects CJS `require`, not
  ESM `import` resolution — so the driver imports it via
  `await import('/opt/node22/lib/node_modules/playwright/index.mjs')`
  (overridable with `PLAYWRIGHT_MJS=... node driver.mjs` if that path
  ever changes).
- **`wait-for text=...` must match case-insensitively.** Most section
  headings (`OPERATORLAR`, etc.) are styled with CSS
  `text-transform: uppercase`, and a browser's `.innerText` reflects
  that *rendered* casing, not the original DOM text — so
  `wait-for text=Operatorlar` against the literal mixed-case string
  never matches. The driver lower-cases both sides before comparing.
- **`ERR_CERT_AUTHORITY_INVALID` on Google Fonts.** This sandbox's
  outbound-HTTPS proxy intercepts TLS, so `fonts.googleapis.com`
  preconnects log a console error every run. It's environment noise,
  not an app bug — the pages render fine (system font fallback) either
  way. Don't chase it.
- **SSE-pushed updates need a short `sleep` before screenshotting.**
  `/tv`, `/staff`, and `/admin` all update live over `/events`; a
  `post` command returns as soon as the HTTP response lands, slightly
  before the SSE push reaches the page. `sleep 500`–`800` between a
  `post` and the following `screenshot` avoids catching a stale frame.
