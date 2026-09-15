@echo off
rem ==========================================================================
rem  Bu skript Windows "Startup" papkasiga yorliq qo'yadi, shunda kompyuter
rem  yoqilganda / foydalanuvchi kirganda print-servis + kiosk avtomatik
rem  ishga tushadi. Faqat BIR MARTA ishga tushirish kifoya.
rem
rem  O'chirish uchun: Win+R -> shell:startup -> "Bank navbat kiosk" yorlig'ini
rem  o'chiring.
rem ==========================================================================
setlocal

set "TARGET=%~dp0kiosk-autostart.bat"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\Bank navbat kiosk.lnk"

powershell -NoProfile -Command ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "$sc = $s.CreateShortcut('%LNK%');" ^
  "$sc.TargetPath = '%TARGET%';" ^
  "$sc.WorkingDirectory = '%~dp0';" ^
  "$sc.WindowStyle = 7;" ^
  "$sc.Description = 'Bank navbat: print-servis + kiosk avtomatik ishga tushirish';" ^
  "$sc.Save()"

if exist "%LNK%" (
    echo Tayyor! Endi kompyuter yoqilganda print-servis va kiosk avtomatik ishga tushadi.
    echo Yorliq: %LNK%
) else (
    echo XATOLIK: yorliq yaratilmadi.
)

pause
endlocal
