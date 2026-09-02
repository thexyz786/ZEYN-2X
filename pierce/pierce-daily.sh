#!/bin/zsh
# Pierce daily - pull, build, open. Safe to run by hand any time.
set -uo pipefail
cd "$HOME/pierce" || exit 1
mkdir -p history logs
DAY=$(date +%F)
LOG="logs/$DAY.log"

notify() { osascript -e "display notification \"$1\" with title \"Pierce Daily\"" 2>/dev/null; }

# launchd can fire the calendar interval and the on-wake catch-up close together.
# Two runs racing on sync.json/data.json would interleave a half-written build.
# mkdir is atomic on every filesystem macOS ships; flock is Linux-only.
LOCK="logs/.lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    echo "$(date): another run (pid $(cat "$LOCK/pid")) holds the lock, exiting" >> "$LOG"
    exit 0
  fi
  echo "$(date): clearing stale lock" >> "$LOG"      # previous run was killed
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

{
  echo "=== run $(date) ==="

  # macOS drops python3 when Command Line Tools go missing after an OS update
  if ! command -v python3 >/dev/null; then
    echo "NO PYTHON3"; notify "python3 is gone - run: xcode-select --install"; exit 1
  fi

  if ! python3 canvas_pull.py sync.new.json; then
    echo "PULL FAILED"; rm -f sync.new.json
    notify "Canvas pull failed - opening yesterday's dashboard"
  else
    mv -f sync.new.json sync.json
    BUILT=0
    if python3 dashboard-transform.py sync.json data.raw.json; then
      if python3 pacing.py sync.json data.raw.json data.json brief.md notify.txt; then
        BUILT=1
      else
        echo "GATE FAILED - keeping yesterday's dashboard.html"
      fi
    else
      echo "TRANSFORM FAILED - keeping yesterday's dashboard.html"
      echo "Transform failed - dashboard not rebuilt" > notify.txt
    fi

    if [ "$BUILT" -eq 1 ]; then
      python3 - <<'PY'
import sys
MARK = '/*__DATA__*/' + ';'          # built at runtime so this file is not a match
tpl = open('dashboard-template.html', encoding='utf-8').read()
data = open('data.json', encoding='utf-8').read()
n = tpl.count(MARK)
# Exactly one, or refuse. replace(..., 1) takes the FIRST hit, so a template
# that merely names the marker in a comment silently swallows the payload and
# renders an empty dashboard - and a length check cannot tell the difference.
if n != 1:
    sys.exit("data injection failed - expected 1 injection marker in the "
             "template, found %d" % n)
out = tpl.replace(MARK, data + ';', 1)
open('dashboard.html', 'w', encoding='utf-8').write(out)
print("dashboard.html: %d bytes" % len(out))
PY
      if [ $? -eq 0 ]; then
        cp -f data.json "history/$DAY.json"
        notify "$(cat notify.txt)"
      else
        echo "INJECTION FAILED - keeping yesterday's dashboard.html"
        notify "Dashboard injection failed - template marker missing"
      fi
    else
      notify "$(cat notify.txt 2>/dev/null || echo 'Sync gate failed')"
    fi
  fi

  # tabs: dashboard first, then each live class
  TABS=$(python3 - <<'PY'
import json
try:
    d = json.load(open('data.json', encoding='utf-8'))
    ids = [str(c['id']) for c in d['courses']]
    if not d['meta'].get('cinema_published'):
        ids = [i for i in ids if i != '373626']
except Exception:
    ids = ['372593', '372967', '372991', '373604', '372230']
print(" ".join("https://ilearn.laccd.edu/courses/%s" % i for i in ids))
PY
)
  open -a "Google Chrome" "file://$HOME/pierce/dashboard.html" ${=TABS}

  # a log a day forever is how you lose the disk quietly
  find logs -name '*.log' -type f -mtime +60 -delete 2>/dev/null

  echo "=== done $(date) ==="
} >> "$LOG" 2>&1
