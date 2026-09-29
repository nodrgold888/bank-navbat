@echo off
setlocal
set "DIR=%~dp0"
set "NSSM=%DIR%nssm.exe"
set "SERVICE_NAME=BankNavbatPrint"
set "TASK_NAME=BankNavbatPrint"

if exist "%NSSM%" (
    "%NSSM%" stop %SERVICE_NAME%
    "%NSSM%" remove %SERVICE_NAME% confirm
) else (
    schtasks /end /tn "%TASK_NAME%" >nul 2>&1
    schtasks /delete /tn "%TASK_NAME%" /f
)

echo Servis o'chirildi.
pause
endlocal
