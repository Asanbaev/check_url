@echo off
setlocal

set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME_EXE%" (
  echo Google Chrome not found.
  exit /b 1
)

set "USER_DATA_DIR=%LOCALAPPDATA%\check_url\chrome-profile-debug"
if not exist "%USER_DATA_DIR%" mkdir "%USER_DATA_DIR%"

start "" "%CHROME_EXE%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USER_DATA_DIR%" ^
  --new-window ^
  --window-position=0,0 ^
  --window-size=1920,1080 ^
  --no-first-run ^
  --no-default-browser-check
