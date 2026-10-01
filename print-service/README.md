# Print service (kiosk receipt printer)

A small Node service that runs **on the kiosk PC** and prints the customer's
queue receipt on the thermal printer. The kiosk page (`/kiosk-terminal`) calls
it at `http://localhost:9100/print` right after a ticket is issued.

It is **not** part of the Render deployment. Pushing to `main` updates the
website only — the printer app on the kiosk PC has to be updated by hand
(see "Updating" below). If the receipt looks old after a change, this is why.

## How it works

1. The kiosk page POSTs the ticket (number, service, date, position, wait) to `/print`.
2. The service builds ESC/POS bytes with `node-thermal-printer`, writes them to a
   temp file, and `copy /b`s that file to the Windows printer share
   (`\\localhost\<share name>`), retrying a few times if the spooler is busy.
3. `GET /health` checks that the printer share is visible.

## Requirements (kiosk PC)

- Windows with Node.js installed.
- The thermal printer installed and **shared** in Windows. The share name defaults
  to `XP-80C`; override with the `PRINTER_SHARE_NAME` environment variable.
- Other optional settings: `BRANCH_PHONE` (printed on the receipt, default `1284`).

## First-time install

Run these from the `print-service` folder:

```bat
npm install
install-print-service.bat
```

Run `install-print-service.bat` **as Administrator**. It installs a Windows service
named `BankNavbatPrint` if `nssm.exe` sits next to it; otherwise it falls back to a
Task Scheduler task with the same name that runs `supervisor.bat` (restarts the
service if it crashes). Either way it starts at boot.

`install-autostart.bat` / `kiosk-autostart.bat` then open the kiosk in Chrome at
`/kiosk-terminal` after the print service answers `/health`.

To run it by hand instead (for testing): `start.bat`.

## Updating (do this after any change under `print-service/`)

1. Copy the new `print-service` folder over the old one on the kiosk PC
   (at least `server.js` and `assets/logo.png`), or `git pull` if the PC has a
   checkout. Run `npm install` if `package.json` changed.
2. Restart the service so the new code is loaded:
   - Windows service (nssm): `sc stop BankNavbatPrint` then `sc start BankNavbatPrint`
   - Task Scheduler fallback or `start.bat`: close it, then run it again — or, if
     nothing else on the PC uses Node, `taskkill /f /im node.exe` and
     `supervisor.bat` starts it again after ~3 seconds. Rebooting also works.
3. Check it is up: open `http://localhost:9100/health` in a browser. It should show
   `{"ok":true,...}`.
4. Print a test receipt and look at the paper. In PowerShell:

   ```powershell
   Invoke-RestMethod -Method Post -Uri http://localhost:9100/print -ContentType 'application/json' -Body '{"service":"Toʻlovlar va pul oʻtkazmalari","number":"C002","ahead":0,"position":1,"etaMin":0,"date":"01.10.2026","day":"Payshanba","time":"09:02"}'
   ```

   The current receipt is compact: logo, bank line, ticket number, "TANLANGAN
   XIZMAT", one date | day | time line, queue position, wait, address, thank-you
   bar. If you still see rows of `*****`, a boxed table, or "Xizmat turi", the old
   code is still running — go back to step 2.

## Troubleshooting

- **Receipt layout didn't change:** the old process is still running (see Updating).
- **Nothing prints, kiosk shows "Chek chop etilmadi":** check `/health`, that the
  printer is on and shared under the expected name, and the service log
  (`service.log` next to `server.js` when installed with nssm).
- **A `?` appears in place of an apostrophe:** the printer codepage can't print
  Uzbek `ʻ`/`ʼ`; the service already converts them to a plain `'` — make sure the
  new code is running.
- **Two receipts for one ticket:** shouldn't happen — the kiosk waits longer than the
  service's own retry budget (~26 s) before it retries. If it does, report it.
