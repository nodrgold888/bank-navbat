@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "server.js" (
    echo.
    echo SERVER.JS TOPILMADI! Bu faylni print-service papkasida saqlang.
    pause
    exit /b 1
)

npm start

echo.
echo Print-servis to'xtadi yoki xatolik yuz berdi.
pause
