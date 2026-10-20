@echo off
rem Double-click target for the desktop shortcut: runs scripts/webchat.sh through Git Bash.
rem Any argument is forwarded (start / stop / restart / status).
setlocal
set "SCRIPT=%~dp0webchat.sh"
set "SCRIPT=%SCRIPT:\=/%"

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=bash"

"%BASH%" "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

rem start opens the browser and can close at once; stop/status/restart print their result, so
rem keep the console up long enough to read it when launched from a desktop shortcut.
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
