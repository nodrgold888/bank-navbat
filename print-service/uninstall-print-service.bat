@echo off
setlocal
set "DIR=%~dp0"
set "NSSM=%DIR%nssm.exe"
set "SERVICE_NAME=BankNavbatPrint"

"%NSSM%" stop %SERVICE_NAME%
"%NSSM%" remove %SERVICE_NAME% confirm

echo Servis o'chirildi.
pause
endlocal
