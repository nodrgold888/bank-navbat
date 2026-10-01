# Agent notes for bank-navbat

This file is for any AI coding agent working on this repo (Codex, Claude Code,
etc.) — practical, current-state notes that complement `README.md` rather than
repeat it. Read `README.md` first for the architecture, service/operator model,
and API surface; this file covers workflow, deployment, and things that aren't
obvious from the code alone.

## What this is

A real-time "take-a-number" queue system for a single bank branch (Davr Bank,
Uchtepa branch, Uzbekistan). Plain Node.js (`server.js`, no framework), static
HTML/CSS/JS per view under `public/`, state pushed to clients over
Server-Sent Events. UI text is Uzbek (Latin script); code/comments/commits are
English.

Four live views, all reachable from one server process: `/kiosk-terminal`
(shared kiosk) and `/kiosk` (personal phone, same page, different auto-return
behavior — see `public/kiosk.js`), `/tv`, `/staff`, `/admin`, plus `/qr`.

## Deployment

- Hosted on **Render**, auto-deploys on every push to `main`. There is no
  staging environment — a push to `main` goes live.
- A companion Windows app lives in `print-service/` (thermal receipt printing)
  and `desktop/` (native kiosk launcher, no bundled Node runtime — see
  `desktop/native/launcher_web.c` and `desktop/build-windows.sh`). Those only
  matter if you're touching the physical kiosk/printer setup, not the web app.

## Git workflow actually used here

- Direct commits to `main`, no PR flow (repo owner's preference). If you're an
  agent that defaults to opening PRs, ask first — this repo doesn't use them.
- A second branch, `claude/printer-service-integration-location-68qe0r`, is
  kept fast-forwarded to `main` after most changes (a Claude Code session
  artifact, not a real feature branch). Safe to ignore or keep in sync;
  doesn't need special handling.
- Commit messages here explain *why*, one or two sentences, no per-tool
  attribution boilerplate needed.

## No automated test suite

There isn't one. Verification means actually running the server and looking
at the rendered pages:

```bash
npm install   # first time only
npm start     # serves on :3000 (PORT env var to override)
curl -sf http://localhost:3000/api/state   # confirms it's up
```

Then open `/kiosk-terminal`, `/tv`, `/staff`, `/admin` in a browser, or drive
them headlessly (Playwright or equivalent) — nav to a page, hit the JSON API
(`POST /api/ticket`, `POST /api/call-next`, etc. — see README's API table) to
change state, and confirm the page updates live over SSE (small delay, ~500ms,
between the POST and the page reflecting it). A Claude Code skill at
`.claude/skills/run-bank-navbat/` documents this exact loop with a reusable
driver script if you want a reference for the commands, even though it's
written for Claude Code specifically.

## Current state of the TV screen (`/tv`), as of the latest commit

The TV was redesigned several times (glass, neon, navy, light-with-sidebar).
The owner's final choice is the current layout:

- Light, clean page (pale teal wash, white cards, navy text, green accents).
  `public/tv.html`, `tv.js` and `tv.css` are self-contained; the old
  `body.tv` rules in `style.css` are no longer used by this page.
- **Every operator has its own big "now serving" card** (`.card` in
  `public/tv.js`): a teal/green card with the ticket code, an arrow pill with
  the operator name, and the service name; a free operator is a grey "Bo'sh"
  card. The most recently called card gets an outline and a short pulse.
- **Valyuta (operator 7) is its own wide gold card above the grid** — keep it
  separate from the equal-size grid; don't merge it without asking.
- A "Keyingilar" strip along the bottom lists the waiting tickets. The header
  is deliberately just the brand, live dot, sound buttons and clock — the
  owner asked for the queue-summary boxes that used to sit in the middle to be
  removed; don't re-add them.
- Voice/TTS announcement controls (`#voiceSelect`, `#voiceTest` in
  `public/tv.html`) exist but are deliberately `hidden` — the feature works
  (see `Navbat.speak`/`Navbat.hasTTS` in `public/common.js`) but no acceptable
  Uzbek voice has been found yet on the deployed hardware. Don't remove the
  code, and don't un-hide it without being asked.

If you change this page's design, take a real screenshot before and after
(see the run skill above) rather than reasoning about CSS in the abstract.
Older designs are in git history.

## Gotchas worth knowing up front

- Section headings and some labels are CSS `text-transform: uppercase`; a
  browser's `.innerText` reflects that rendered casing, not the source DOM
  text — matters if you're scripting text-based assertions against the pages.
- `Cache-Control: no-store` is set deliberately on static assets and API
  responses (`server.js`), plus a `?v=<boot-timestamp>` cache-busting query
  param on local `<script>`/`<link>` tags — this was added after a real
  incident where a stale cached JS file caused a kiosk to silently misbehave
  on deployed hardware. Don't relax this without a good reason.
- `/kiosk-terminal` and `/kiosk` serve the same `kiosk.html`, distinguished by
  **path**, not a `?shared=1` query string — a previous query-string-based
  approach broke because some proxies/CDNs strip query strings. Keep using
  the path-based check in `public/kiosk.js` (`IS_SHARED_KIOSK`).
