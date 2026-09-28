@echo off
rem ==========================================================================
rem  TV ekranini avtomatlashtirish uchun skript.
rem
rem  MUHIM: TV hech qachon bosilmaydi/tegilmaydi — shuning uchun brauzer
rem  "autoplay" siyosati chaqiruv signalini (va ovozli e'lonni) jim bloklab
rem  qo'yishi mumkin, chunki hech qanday foydalanuvchi harakati (klik/tegish)
rem  sodir bo'lmagan. --autoplay-policy=no-user-gesture-required bayrog'i
rem  aynan shu cheklovni olib tashlaydi. Signal ishlamayotgan bo'lsa, birinchi
rem  tekshiradigan narsa — TV shu skript orqali (yoki shu bayroq bilan)
rem  ochilganmi, yo'qmi.
rem
rem  Bu faylni Windows "Startup" papkasiga (Win+R -> shell:startup) yorliq
rem  sifatida qo'ysangiz, foydalanuvchi kirganda Chrome o'zi ochiladi.
rem ==========================================================================
setlocal

if "%TV_URL%"=="" set "TV_URL=https://bank-navbat.onrender.com/tv"

echo TV ochilmoqda: %TV_URL%
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --incognito "%TV_URL%"

endlocal
