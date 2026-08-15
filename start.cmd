@echo off
setlocal
rem Run to start Maestro. Do not open public\index.html directly.
rem
rem This is the launcher to use on a managed machine: Maestro.exe is an
rem unsigned, self-compiled binary that starts a hidden process, which is
rem exactly the shape corporate antivirus quarantines. This file does the same
rem job with the node that Claude Code already requires, and has nothing to
rem flag: no compiled binary, no download, no execution-policy bypass.
rem
rem It starts the server with no window, waits for it to answer, opens the UI,
rem and then closes itself. Nothing is left on the taskbar, so there is no
rem console to Ctrl+C - closing the Maestro window stops the server about ten
rem seconds later, and the Quit button in the header stops it at once.

cd /d "%~dp0"
if "%MAESTRO_PORT%"=="" set "MAESTRO_PORT=4144"
set "MAESTRO_URL=http://127.0.0.1:%MAESTRO_PORT%"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

rem Already running? Then this is a second double-click, not a start. Skip
rem straight to opening the UI - the old behaviour here was to launch anyway,
rem collide on the port, and die with "address in use" and no browser.
call :health && goto :open

rem MAESTRO_NO_OPEN stops the server opening a second, ordinary browser tab -
rem the app-mode window below is the one we want.
set "MAESTRO_NO_OPEN=1"
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden" >nul 2>&1
if errorlevel 1 goto :foreground

set /a tries=0
:wait
call :health && goto :open
set /a tries+=1
if %tries% geq 30 goto :foreground
ping -n 2 127.0.0.1 >nul
goto :wait

:open
rem App mode strips the address bar and tab strip, so the window reads as
rem Maestro rather than as a localhost tab - the one thing worth keeping from
rem Maestro.exe. Chrome first, then Edge; a machine with neither falls through
rem to the default browser as an ordinary tab. Set MAESTRO_BROWSER to the full
rem path of a Chromium browser to override the search.
if not "%MAESTRO_BROWSER%"=="" if exist "%MAESTRO_BROWSER%" (
  set "BROWSER=%MAESTRO_BROWSER%"
  goto :app
)
set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER%" goto :app
set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER%" goto :app
set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER%" goto :app
set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER%" goto :app
set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER%" goto :app
start "" "http://localhost:%MAESTRO_PORT%"
exit /b 0
:app
start "" "%BROWSER%" --app=%MAESTRO_URL% --window-size=1280,900
exit /b 0

rem The hidden server never answered. Run it in this window instead, so
rem whatever it is complaining about is on screen rather than swallowed.
:foreground
echo Maestro did not come up in the background - starting it here so you can
echo see why. Close this window to stop it.
echo.
set "MAESTRO_NO_OPEN="
node server.js
echo.
pause
exit /b 1

rem Returns 0 when the server answers on the port.
:health
curl -s -o NUL -m 2 "%MAESTRO_URL%/api/health"
exit /b %errorlevel%
