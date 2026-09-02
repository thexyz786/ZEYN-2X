#!/usr/bin/env bash
# End-to-end test of stages 2-5 against FABRICATED Canvas payloads.
# Stage 1 (canvas_pull.py) cannot be tested here: ilearn.laccd.edu is blocked
# by network policy in every cloud container. It is only compile-checked.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK/history"
cd "$WORK" || exit 1
cp "$HERE/stub_transform.py" dashboard-transform.py
cp "$HERE/stub_template.html" dashboard-template.html
cp "$HERE/inject.py" inject.py
PASS=0; FAIL=0
ok(){ if [ "$1" -eq 0 ]; then echo "  PASS  $2"; PASS=$((PASS+1));
      else echo "  FAIL  $2"; FAIL=$((FAIL+1)); fi; }

echo "== T1  compile checks =="
python3 -m py_compile "$HERE/../canvas_pull.py"; ok $? "canvas_pull.py compiles"
python3 -m py_compile "$HERE/../pacing.py";      ok $? "pacing.py compiles"
bash -n "$HERE/../pierce-daily.sh";              ok $? "pierce-daily.sh parses"
python3 -c "import plistlib,sys;plistlib.load(open(sys.argv[1],'rb'))" \
  "$HERE/../com.hatim.pierce-daily.plist";       ok $? "launchd plist is valid XML"

echo "== T2  cold build, no history =="
python3 "$HERE/make_fixture.py" sync.json >/dev/null;      ok $? "fixture built"
python3 dashboard-transform.py sync.json data.raw.json;    ok $? "stage 2 transform"
python3 "$HERE/../pacing.py" sync.json data.raw.json data.json brief.md notify.txt
ok $? "stage 3 pacing, gate PASS"
python3 - <<'PY'
import json,sys
d=json.load(open('data.json'))
assert d['delta']['merged'] > 0, "nothing merged"
assert d['pacing'], "no pacing"
assert any(c['unmapped'] for c in d['coverage'].values()), "coverage audit found nothing"
assert d['health']['orphans'], "orphan planner item was not detected"
print("   merged=%d  orphans=%d  unmapped_courses=%d" % (
  d['delta']['merged'], len(d['health']['orphans']),
  sum(1 for c in d['coverage'].values() if c['unmapped'])))
PY
ok $? "merge, coverage audit and orphan detection all fired"

echo "== T3  template injection =="
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
print("   dashboard.html %d bytes" % len(out))
PY
ok $? "data injected into template"
python3 - <<'PZ'
import json, sys
s = open('dashboard.html', encoding='utf-8').read()
if '/*__DATA__*' + '/;' in s: sys.exit('marker survived - payload went elsewhere')
i = s.index('const DATA = ') + len('const DATA = ')
json.loads(s[i:s.index(';\nconst el', i)])
print('   payload parses as JSON at the real marker site')
PZ
ok $? "payload landed at the marker, not in a comment"
mkdir -p dup && cp data.json inject.py dup/
printf '%s\n' "<!-- names the /*__DATA__*/; marker -->" \
  '<script>const DATA = /*__DATA__*/;</script>' > dup/dashboard-template.html
( cd dup && python3 inject.py >dup.out 2>&1 )
grep -q 'found 2' dup/dup.out
ok $? "a template naming the marker twice is refused"
# canary and delta compare against the last NON-today snapshot, so date it
# yesterday - a today-dated file is skipped by design and tests nothing
cp -f data.json "history/$(python3 -c 'import datetime;print((datetime.date.today()-datetime.timedelta(days=1)).isoformat())').json"

echo "== T4  gate fires on a collapsed pull =="
python3 "$HERE/make_fixture.py" sync.bad.json --collapse >/dev/null
python3 dashboard-transform.py sync.bad.json data.bad.json >/dev/null
python3 "$HERE/../pacing.py" sync.bad.json data.bad.json data.out.json b.md n.txt 2>/dev/null
[ $? -eq 2 ]; ok $? "collapsed pull exits 2 (gate refused to overwrite)"
[ -s n.txt ]; ok $? "notification text written on gate fail"
[ ! -f data.out.json ]; ok $? "nothing written on gate fail"

echo "== T5  health canary: a course that was live yesterday errors today =="
python3 "$HERE/make_fixture.py" sync.err.json --err 373604 >/dev/null
python3 dashboard-transform.py sync.err.json data.err.json >/dev/null
python3 "$HERE/../pacing.py" sync.err.json data.err.json data.out2.json b2.md n2.txt 2>/dev/null
[ $? -eq 2 ]; ok $? "newly-erroring course exits 2"
grep -q "returned data yesterday" n2.txt; ok $? "canary names the cause"

echo "== T6  warm rerun against yesterday's snapshot =="
python3 "$HERE/make_fixture.py" sync.json >/dev/null
python3 dashboard-transform.py sync.json data.raw.json >/dev/null
python3 "$HERE/../pacing.py" sync.json data.raw.json data.json brief.md notify.txt
ok $? "normal rerun with history exits 0"

echo "== T7  aged term: past calendar/pages must not read as overdue =="
python3 "$HERE/make_fixture.py" sync.aged.json >/dev/null
python3 - <<'PY2'
import json
from datetime import datetime, timezone, timedelta
NOW = datetime.now(timezone.utc)
def iso(d, h=15):
    return (NOW+timedelta(days=d)).replace(hour=h, minute=0, second=0,
                                           microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
s = json.load(open('sync.aged.json'))
for cid, c in s['courses'].items():
    if c.get('err'): continue
    k = c['name'][:6]
    # eight weeks of weekly office hours already gone by, plus a future exam
    c['cal'] = [[8000+w, "%s office hours wk%d" % (k, w), iso(-w*7), iso(-w*7), ""]
                for w in range(1, 9)]
    c['cal'].append([8100, "%s Midterm Exam" % k, iso(9, 14), iso(9, 16), ""])
    c['disc'] = [[7200, "%s ungraded thread" % k, None, iso(-40), iso(-45), True, "", "hi"]]
    c['pages'] = [["wk2", "%s Week 2 checklist" % k, iso(-35), iso(-35)]]
json.dump(s, open('sync.aged.json', 'w'))
PY2
python3 dashboard-transform.py sync.aged.json data.aged.json >/dev/null
python3 "$HERE/../pacing.py" sync.aged.json data.aged.json data.aged.out.json \
        brief.aged.md notify.aged.txt
ok $? "aged-term build succeeds"
python3 - <<'PY2'
import json, sys
d = json.load(open('data.aged.out.json'))
p = d['pacing']
bad = {k: v['missing'] for k, v in p.items() if v['missing'] > 3}
if bad:
    sys.exit("past calendar/page items counted as missing: %s" % bad)
if not any(v['untracked'] for v in p.values()):
    sys.exit("untracked dated items were dropped instead of disclosed")
if sum(v['missing'] for v in p.values()) != 2:
    sys.exit("expected exactly the 2 real gradebook misses, got %d"
             % sum(v['missing'] for v in p.values()))
print("   missing=2 (the real ones)  untracked disclosed per course")
PY2
ok $? "only real gradebook misses count as overdue"


echo
echo "== result: $PASS passed, $FAIL failed =="
echo "workdir: $WORK"
[ "$FAIL" -eq 0 ]
