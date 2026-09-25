@echo off
rem ==========================================================================
rem  Kiosk kompyuterini avtomatlashtirish uchun skript.
rem  Print-servis endi Windows XIZMATI (BankNavbatPrint) sifatida ishlaydi —
rem  kompyuter yoqilgan zahoti, foydalanuvchi kirishidan oldin ham ishga
rem  tushadi. Shu skript endi faqat:
rem   1) Print-servis /health javob berguncha kutadi
rem   2) Chrome'ni kiosk rejimida to'g'ridan-to'g'ri ochadi
rem
rem  MUHIM: URL har doim shu yerdan, to'g'ridan-to'g'ri ochiladi — Desktop
rem  papkasidagi alohida kiosk.bat fayliga endi tayanilmaydi. Bu fayl avval
rem  bor bo'lsa o'sha ishlatilardi, lekin uning ichida "?shared=1" borligiga
rem  kafolat yo'q edi — shu bayroqsiz sahifa "oddiy telefon" rejimida ishlaydi
rem  (avtomatik qaytish HAM, katta kiosk o'lchami HAM ishlamaydi), va bu holat
rem  hech qanday xato chiqarmaydi, shunchaki "chek chiqargandan keyin orqaga
rem  qaytmayapti" bo'lib ko'rinadi. Manzilni faqat pastdagi KIOSK_URL orqali
rem  o'zgartiring.
rem
rem  Bu faylni Windows "Startup" papkasiga (Win+R -> shell:startup) yorliq
rem  sifatida qo'ysangiz, foydalanuvchi kirganda Chrome o'zi ochiladi.
rem ==========================================================================
setlocal

if "%KIOSK_URL%"=="" set "KIOSK_URL=https://davrbank-uchtepa.online/kiosk?shared=1"

echo Print-servis (Windows xizmati) tayyor boʻlishini kutyapmiz...
set /a tries=0

:waitloop
set "HEALTH="
for /f "usebackq delims=" %%H in (`curl -s -o nul -w "%%{http_code}" http://localhost:9100/health 2^>nul`) do set "HEALTH=%%H"
if "%HEALTH%"=="200" goto ready
set /a tries+=1
if %tries% GEQ 20 (
    echo OGOHLANTIRISH: Print-servis 20 soniyada javob bermadi.
    echo Windows xizmati holatini tekshiring: sc query BankNavbatPrint
    echo Baribir kiosk ochiladi.
    goto ready
)
timeout /t 1 /nobreak >nul
goto waitloop

:ready
echo Print-servis tayyor. Kiosk ochilmoqda: %KIOSK_URL%
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --incognito "%KIOSK_URL%"

endlocal
