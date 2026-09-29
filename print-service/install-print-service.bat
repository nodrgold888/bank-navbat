@echo off
rem ==========================================================================
rem  Print-servisni haqiqiy Windows xizmati (service) qilib o'rnatadi.
rem  nssm.exe shu bat fayl bilan bir xil papkada bo'lishi kerak.
rem  Bu skriptni ADMINISTRATOR sifatida ishga tushirish kerak.
rem ==========================================================================
setlocal

set "DIR=%~dp0"
set "NSSM=%DIR%nssm.exe"
set "SERVICE_NAME=BankNavbatPrint"
set "TASK_NAME=BankNavbatPrint"

if not exist "%NSSM%" (
    echo NSSM topilmadi. Windows Task Scheduler fallback ishlatiladi.
    echo Print-servis kompyuter yoqilganda avtomatik ishga tushadi.
    schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
    schtasks /create /tn "%TASK_NAME%" /tr "cmd.exe /d /c \"\"%DIR%supervisor.bat\"\"" /sc onstart /ru SYSTEM /rl HIGHEST /f
    if errorlevel 1 (
        echo XATOLIK: avtomatik task yaratilmadi. Skriptni Administrator sifatida ishga tushiring.
        pause
        exit /b 1
    )
    schtasks /run /tn "%TASK_NAME%"
    echo.
    echo Tayyor. Holatni tekshirish uchun: schtasks /query /tn "%TASK_NAME%"
    pause
    exit /b 0
)

for /f "delims=" %%N in ('where node') do set "NODE=%%N"
if "%NODE%"=="" (
    echo XATOLIK: node.exe topilmadi. Node.js o'rnatilganini tekshiring.
    pause
    exit /b 1
)

echo Node.js:  %NODE%
echo Papka:    %DIR%
echo Servis:   %SERVICE_NAME%
echo.

rem Agar avval o'rnatilgan bo'lsa, tozalab qayta o'rnatamiz
"%NSSM%" stop %SERVICE_NAME% >nul 2>&1
"%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1

"%NSSM%" install %SERVICE_NAME% "%NODE%" "%DIR%server.js"
"%NSSM%" set %SERVICE_NAME% AppDirectory "%DIR%"
"%NSSM%" set %SERVICE_NAME% Start SERVICE_AUTO_START
"%NSSM%" set %SERVICE_NAME% AppStdout "%DIR%service.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%DIR%service.log"
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 3000
"%NSSM%" set %SERVICE_NAME% Description "Davr Bank kiosk - termal printer uchun lokal print-servis"

"%NSSM%" start %SERVICE_NAME%

echo.
echo ==========================================================================
echo  Tayyor. Servis holatini tekshirish uchun:  sc query %SERVICE_NAME%
echo  Loglarni ko'rish uchun:                    type "%DIR%service.log"
echo ==========================================================================
pause
endlocal
