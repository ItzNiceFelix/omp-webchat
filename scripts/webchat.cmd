@echo off
rem Double-click target from Explorer: runs scripts/webchat.sh through Git Bash.
rem The desktop shortcuts do not use this file, they call scripts/webchat.vbs through wscript so
rem no console appears; this shim stays for a plain double-click, where a window is expected.
rem Any argument is forwarded (start / stop / restart / status).
setlocal
set "SCRIPT=%~dp0webchat.sh"
set "SCRIPT=%SCRIPT:\=/%"

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=bash"

"%BASH%" "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

rem start opens the browser and can close at once; stop/status/restart print their result, so
rem keep this window up long enough to read it. The desktop shortcuts use webchat.vbs instead and
rem report failures with a message box.
rem `timeout` needs console stdin (it fails under redirection), `ping` does not.
if /i "%~1"=="start" goto :done
if "%~1"=="" goto :done
ping -n 4 127.0.0.1 >nul 2>&1
:done
if not "%CODE%"=="0" (
	echo.
	echo omp-webchat exited with code %CODE%
	pause
)
exit /b %CODE%
