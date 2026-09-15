@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "server.js" (
    echo.
    echo SERVER.JS TOPILMADI! Bu faylni bank-navbat papkasida saqlang.
    pause
    exit /b 1
)

npm start

echo.
echo Server to'xtadi yoki xatolik yuz berdi.
pause
