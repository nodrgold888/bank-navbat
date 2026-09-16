@echo off
rem ==========================================================================
rem  Kiosk kompyuterini avtomatlashtirish uchun skript.
rem  Print-servis endi Windows XIZMATI (BankNavbatPrint) sifatida ishlaydi —
rem  kompyuter yoqilgan zahoti, foydalanuvchi kirishidan oldin ham ishga
rem  tushadi. Shu skript endi faqat:
rem   1) Print-servis /health javob berguncha kutadi
rem   2) Chrome'ni kiosk rejimida ochadi (Desktop\kiosk.bat orqali)
rem
rem  Bu faylni Windows "Startup" papkasiga (Win+R -> shell:startup) yorliq
rem  sifatida qo'ysangiz, foydalanuvchi kirganda Chrome o'zi ochiladi.
rem ==========================================================================
setlocal

set "DESKTOP=%USERPROFILE%\Desktop"

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
echo Print-servis tayyor. Kiosk ochilmoqda...
if exist "%DESKTOP%\kiosk.bat" (
    call "%DESKTOP%\kiosk.bat"
) else (
    echo OGOHLANTIRISH: %DESKTOP%\kiosk.bat topilmadi — Chrome qo'lda ochiladi.
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --incognito "https://davrbank-uchtepa.online/kiosk?shared=1"
)

endlocal
