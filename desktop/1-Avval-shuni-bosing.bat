@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "node.exe" (
    echo node.exe allaqachon mavjud. Hech narsa qilish shart emas.
    echo Endi DavrBank-Server.exe / DavrBank-Operator.exe / DavrBank-Admin.exe / DavrBank-TV.exe ni ishga tushirsangiz bo'ladi.
    pause
    exit /b 0
)

echo node.exe yuklab olinmoqda (internet aloqasi kerak, faqat bir marta)...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.21.0/win-x64/node.exe' -OutFile 'node.exe'"

if exist "node.exe" (
    echo.
    echo Tayyor! Endi DavrBank-Server.exe / DavrBank-Operator.exe / DavrBank-Admin.exe / DavrBank-TV.exe ni ishga tushiring.
) else (
    echo.
    echo XATOLIK: node.exe yuklab olinmadi. Internet aloqangizni tekshiring
    echo yoki node.exe faylini qo'lda https://nodejs.org/en/download dan
    echo yuklab, shu papkaga joylashtiring ^(fayl nomi aynan "node.exe" bo'lsin^).
)
echo.
pause
