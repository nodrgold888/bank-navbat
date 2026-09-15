@echo off
rem ==========================================================================
rem  Kiosk kompyuterini to'liq avtomatlashtirish uchun bitta skript:
rem   1) Print-servisni (supervisor bilan, qulasa qayta tiklanadi) fon rejimida
rem      ishga tushiradi
rem   2) Print-servis /health javob berguncha kutadi
rem   3) Chrome'ni kiosk rejimida ochadi (Desktop\kiosk.bat orqali)
rem
rem  Bu faylni Windows "Startup" papkasiga (Win+R -> shell:startup) yorliq
rem  sifatida qo'ysangiz, kompyuter yoqilganda / qayta ishga tushganda hammasi
rem  o'zi avtomatik ishga tushadi — qo'lda hech narsani bosish shart emas.
rem ==========================================================================
setlocal

set "PRINT_DIR=%~dp0"
set "DESKTOP=%USERPROFILE%\Desktop"

echo Print-servis ishga tushirilmoqda...
start "Print-servis" /min cmd /c ""%PRINT_DIR%supervisor.bat""

echo Print-servis tayyor boʻlishini kutyapmiz...
set /a tries=0

:waitloop
set "HEALTH="
for /f "usebackq delims=" %%H in (`curl -s -o nul -w "%%{http_code}" http://localhost:9100/health 2^>nul`) do set "HEALTH=%%H"
if "%HEALTH%"=="200" goto ready
set /a tries+=1
if %tries% GEQ 20 (
    echo OGOHLANTIRISH: Print-servis 20 soniyada javob bermadi — baribir kiosk ochiladi.
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
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --incognito "https://bank-navbat.onrender.com/kiosk"
)

endlocal
