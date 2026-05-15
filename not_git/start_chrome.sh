#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
  USER_DATA_DIR="${LOCALAPPDATA:-${USERPROFILE}\\AppData\\Local}\\check_url\\chrome-profile-debug"
  CHROME_EXE="/c/Program Files/Google/Chrome/Application/chrome.exe"
  if [[ ! -x "$CHROME_EXE" ]]; then
    CHROME_EXE="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  fi
  if [[ ! -x "$CHROME_EXE" ]]; then
    echo "Не найден chrome.exe. Проверь установку Google Chrome." >&2
    exit 1
  fi
  exec "$CHROME_EXE" \
    --remote-debugging-port=9222 \
    --user-data-dir="$USER_DATA_DIR" \
    --new-window \
    --window-position=0,0 \
    --window-size=1920,1080 \
    --no-first-run \
    --no-default-browser-check
  ;;
*)
  USER_DATA_DIR="${HOME}/.cache/check_url/chrome-profile-debug"
  mkdir -p "${USER_DATA_DIR}"
  exec /usr/bin/google-chrome \
    --remote-debugging-port=9222 \
    --user-data-dir="${USER_DATA_DIR}" \
    --new-window \
    --window-position=0,0 \
    --window-size=1920,1080 \
    --no-first-run \
    --no-default-browser-check
  ;;
esac
