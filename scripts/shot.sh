#!/bin/sh
# Headless Chrome screenshot: scripts/shot.sh <url> <out.png> [width] [height]
C="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
timeout 90 "$C" --headless=new --disable-gpu --user-data-dir="$(pwd)/.chrome-tmp" --hide-scrollbars \
  --window-size="${3:-1024},${4:-700}" --virtual-time-budget=8000 --screenshot="$2" "$1" 2>&1 | grep -i "written"
