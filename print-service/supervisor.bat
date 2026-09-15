@echo off
chcp 65001 >nul
rem Print-servisni ishga tushiradi va u qulasa (yoki chiqsa) avtomatik qayta ishga tushiradi.
cd /d "%~dp0"

:loop
echo [%date% %time%] Print-servis ishga tushmoqda...
node server.js
echo [%date% %time%] Print-servis to'xtadi (chiqish kodi %errorlevel%). 3 soniyadan keyin qayta ishga tushadi...
timeout /t 3 /nobreak >nul
goto loop
