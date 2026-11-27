#!/bin/zsh
# chrome.sh <url> <seconds>: run headless Chromium on a bench page, print what it reported.
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "$(dirname "$0")"; rm -f results.jsonl; rm -rf prof
"$CH" --headless=new --user-data-dir=$PWD/prof --autoplay-policy=no-user-gesture-required --window-size=400,200 --remote-debugging-port=9378 --use-angle=metal "$1" >/dev/null 2>&1 &
pid=$!
for i in $(seq 1 $(( $2 * 2 ))); do sleep 0.5; grep -q '"done": *true\|"done":true' results.jsonl 2>/dev/null && break; done
kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf prof
cat results.jsonl 2>/dev/null
