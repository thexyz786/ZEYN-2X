#!/usr/bin/env python3
"""Stage 3 - merge, pace, gate, brief.

usage: pacing.py sync.json data.raw.json data.json brief.md notify.txt
Exit 0 = good build. Exit 2 = gate failed, nothing written, keep yesterday.
"""
import json, os, re, sys, glob
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

if len(sys.argv) < 6:
    sys.exit("usage: pacing.py sync.json data.raw.json data.json brief.md notify.txt")
sync_p, raw_p, out_p, brief_p, note_p = sys.argv[1:6]
with open(sync_p, encoding="utf-8") as fh:
    sync = json.load(fh)
with open(raw_p, encoding="utf-8") as fh:
    D = json.load(fh)
items, meta = D["items"], D["meta"]


def cidstr(v):
    """Course ids arrive as int from Canvas and str from the transform.
    Everything downstream compares them, so normalise once, here."""
    return "" if v is None else str(v)


for _i in items:                       # normalise before anything indexes on cid
    _i["cid"] = cidstr(_i.get("cid"))
KEY = {cidstr(c["id"]): c["key"] for c in D["courses"]}
CRS = {c["key"]: c for c in D["courses"]}
ORDER = [c["key"] for c in D["courses"]]
RAW_N = len(items)                                    # counts before the merge, so a
RAW_DATED = sum(1 for i in items if i.get("due"))     # collapsed pull cannot hide behind them
NOW = datetime.now(timezone.utc)
PT = ZoneInfo(meta.get("tz_school", "America/Los_Angeles"))
LOCAL = datetime.now().astimezone().tzinfo


def dt(s):
    """Always returns an aware UTC-comparable datetime, or None.

    A date-only field (page todo_date, some calendar rows) parses naive, and
    comparing that to NOW raises TypeError and kills the whole build. Assume
    naive means UTC rather than crashing."""
    if not s:
        return None
    raw = str(s).strip().replace("Z", "+00:00")
    d = None
    try:
        d = datetime.fromisoformat(raw)
    except Exception:
        for f in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                d = datetime.strptime(raw, f)
                break
            except Exception:
                continue
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())[:60]


def when(s):
    d = dt(s)
    if not d:
        return "no date"
    return "%s local / %s PT" % (d.astimezone(LOCAL).strftime("%a %d %b %H:%M"),
                                 d.astimezone(PT).strftime("%H:%M"))


# Dated maintenance the system cannot do for itself. Surfaces in the brief 10 days
# ahead, so the thing that has to be hand-edited reminds you before it goes stale.
MAINT = [
    ("2026-09-13", "Drop deadline without a W, per the COUNSEL syllabus - verify the real "
                   "date in mycollege SIS and correct the waypoint"),
    ("2026-10-01", "Back in Woodland Hills: set meta tz_home to America/Los_Angeles in "
                   "dashboard-transform.py, or the dashboard keeps leading with IST"),
    ("2026-10-18", "CINEMA go/no-go: comfortably ahead everywhere, or drop before it starts"),
    ("2026-10-26", "CINEMA 107 opens. Its COURSES block still says 'Not published yet' - "
                   "read the syllabus and write in the real grading split and late rule"),
    ("2026-11-01", "US clocks fall back. Check one PT deadline renders an hour later than "
                   "it did yesterday; if it does not, the template is hard-coding an offset"),
    ("2026-11-22", "Last day to drop with a W (verify in SIS - CINEMA's 8-week date is earlier)"),
    ("2026-12-14", "Finals week. Stop editing the transform; you do not want a build "
                   "failure the morning a final is due"),
    ("2026-12-20", "Term ends. Archive history/, then rebuild COURSE_IDS for Spring 2027"),
]

seen = {(i["cid"], norm(i["name"])) for i in items}
aids = {(i["cid"], str(i.get("id"))) for i in items if i.get("id") is not None}
orphans = []


def add(cid, name, kind, due, url, src):
    cid = cidstr(cid)
    k = (cid, norm(name))
    if not name or k in seen:
        return 0
    if cid not in KEY:
        # A dated item for a course the transform does not know about would be
        # filed under "?" and then dropped silently by every per-course loop
        # below. Count it instead, and say so in the brief.
        orphans.append((cid, name, src))
        return 0
    seen.add(k)
    items.append(dict(c=KEY[cid], cid=cid, id=None, name=name, kind=kind,
                      pts=None, due=due, unlock=None, lock=None,
                      url=url or "https://ilearn.laccd.edu/courses/%s" % cid,
                      ext=False, attempts=None, timelimit=None,
                      sub=dict(state="unsubmitted"), src=src, gradeable=False,
                      srcnote="From the Canvas %s list - no gradebook row, so Canvas "
                              "tracks no submission state for it" % src))
    return 1


# ---- merge the things a gradebook-only pull cannot see -----------------------
merged, coverage = 0, {}
for cid, c in (sync.get("courses") or {}).items():
    cid = cidstr(cid)
    if not isinstance(c, dict) or c.get("err"):
        continue
    for d in (c.get("disc") or []):
        did, title, aid, date, posted, pub, url, _msg = (list(d) + [None] * 8)[:8]
        if aid is not None and (cid, str(aid)) in aids:
            continue
        if pub and date:
            merged += add(cid, title, "discussion", date, url, "discussion")
    for e in (c.get("cal") or []):
        _id, title, start, _end, url = (list(e) + [None] * 5)[:5]
        if start:
            kind = "exam" if re.search(r"exam|midterm|final|proctor", title or "", re.I) else "admin"
            merged += add(cid, title, kind, start, url, "calendar")
    for p in (c.get("pages") or []):
        slug, title, todo, _upd = (list(p) + [None] * 4)[:4]
        if todo:
            merged += add(cid, title, "admin", todo,
                          "https://ilearn.laccd.edu/courses/%s/pages/%s" % (cid, slug), "page")

for row in (sync.get("planner") or []):
    ptype, pid, pcid, title, date, url, submitted = (list(row) + [None] * 7)[:7]
    # No "cid in KEY" guard here: add() does that check and records the misses
    # as orphans. Filtering them out first made an untracked course silently
    # invisible, which is the failure mode this whole system exists to prevent.
    if date and not submitted:
        merged += add(cidstr(pcid), title, "homework", date, url, "planner")

# ---- coverage audit: what the course holds that has no dated gradebook row ----
for cid, c in (sync.get("courses") or {}).items():
    cid = cidstr(cid)
    if not isinstance(c, dict) or c.get("err"):
        continue
    names = {norm(i["name"]) for i in items if i["cid"] == cid}
    graded_unmapped, materials, gated = [], 0, 0
    for m in (c.get("mod") or []):
        mit = m[5] if len(m) > 5 else []
        for it in (mit or []):
            _iid, title, itype, _cidx, url, req, done, pub = (list(it) + [None] * 8)[:8]
            if not pub:
                continue
            if itype in ("Assignment", "Quiz", "Discussion"):
                if norm(title) not in names:
                    graded_unmapped.append([title, itype, url])
            else:
                materials += 1
            if req and not done:
                gated += 1
    coverage[KEY.get(cid, cid)] = dict(
        modules=len(c.get("mod") or []), materials=materials,
        incomplete_requirements=gated, unmapped=graded_unmapped[:12],
        syllabus_chars=len(c.get("syllabus") or ""),
        files=[f[0] for f in (c.get("files") or [])])

# ---- pacing -----------------------------------------------------------------
def submitted(i):
    s = i.get("sub") or {}
    return bool(s.get("excused")) or s.get("score") is not None or \
        (s.get("state") or "") not in ("", "unsubmitted")


def gradeable(i):
    """True only for items with a real gradebook row.

    Merged discussions, calendar events and dated pages carry no submission
    record - Canvas cannot say whether you did them. Counting them as
    unsubmitted marked every past office hour "overdue and unsubmitted" and
    pinned every course at "behind" from about week 6 of term onward, which is
    how a dashboard becomes wallpaper. Only the gradebook can accuse you."""
    return i.get("gradeable", True)


def workload(i):
    """Counts toward the per-week load. Excludes admin: office hours, dated
    pages and other calendar furniture are things to know, not things to do."""
    return gradeable(i) or i.get("kind") != "admin"


pace, overdue, soon, upcoming = {}, [], [], []
for key in ORDER:
    mine = [i for i in items if i["c"] == key]
    dated = [i for i in mine if dt(i["due"])]
    past = [i for i in dated if dt(i["due"]) <= NOW and gradeable(i)]
    done = [i for i in past if submitted(i)]
    miss = [i for i in past if not submitted(i) and not i.get("forecast")]
    n7 = [i for i in dated if NOW < dt(i["due"]) <= NOW + timedelta(days=7)]
    n14 = [i for i in dated if NOW < dt(i["due"]) <= NOW + timedelta(days=14)]
    n48 = [i for i in dated if NOW < dt(i["due"]) <= NOW + timedelta(hours=48)]
    rem = [i for i in dated if dt(i["due"]) > NOW and workload(i)]
    # weeks of runway left in this course, floored at one so the rate cannot
    # divide by zero on the last week of term
    if rem:
        span_days = (max(dt(i["due"]) for i in rem) - NOW).total_seconds() / 86400.0
        weeks = max(1.0, span_days / 7.0)
    else:
        weeks = 1.0
    rate = len(rem) / weeks
    overdue += miss
    soon += n48
    upcoming += n7
    pace[key] = dict(
        total=len(mine), dated=len(dated), undated=len(mine) - len(dated),
        past=len(past), done=len(done), missing=len(miss),
        next48=len(n48), next7=len(n7), next14=len(n14),
        untracked=len([i for i in dated if not gradeable(i)]),
        next7_pts=round(sum(i.get("pts") or 0 for i in n7), 1),
        remaining=len(rem), avg_per_week=round(rate, 1),
        load_ratio=round(len(n7) / max(0.5, rate), 2) if rem else 0,
        grade=(D.get("grades") or {}).get(key),
        verdict=("behind" if miss else "heavy" if rem and len(n7) > 1.5 * rate
                 else "level"))

overdue.sort(key=lambda i: dt(i["due"]))
soon.sort(key=lambda i: dt(i["due"]))
upcoming.sort(key=lambda i: dt(i["due"]))

# ---- course health: a course that was live yesterday must be live today ------
errored = sorted({KEY.get(cidstr(cid), cidstr(cid))
                  for cid, c in (sync.get("courses") or {}).items()
                  if isinstance(c, dict) and (c.get("err") or c.get("a") is None)})

# ---- diff against the last snapshot -----------------------------------------
hist = sorted(glob.glob(os.path.join(os.path.dirname(out_p) or ".", "history", "*.json")))
today = datetime.now().strftime("%Y-%m-%d")
prev = None
for p in reversed(hist):
    if today not in os.path.basename(p):
        try:
            with open(p, encoding="utf-8") as fh:
                prev = json.load(fh)
        except Exception:
            prev = None
        break

# how many of the last 7 mornings actually produced a snapshot
days = {os.path.basename(p)[:10] for p in hist}
first = min(days) if days else None
missed = [(datetime.now() - timedelta(days=k)).strftime("%Y-%m-%d") for k in range(1, 8)]
missed = [d for d in missed if d not in days and first and d > first]

new_items, moved, graded_new, prev_err = [], [], [], None
prev_dated = 0
if prev:
    prev_err = (prev.get("health") or {}).get("errored")
    old = {(cidstr(i["cid"]), norm(i["name"])): i for i in prev.get("items", [])}
    prev_dated = (prev.get("delta") or {}).get("raw_dated") or \
        sum(1 for i in prev.get("items", []) if i.get("due"))
    for i in items:
        o = old.get((i["cid"], norm(i["name"])))
        if not o:
            new_items.append(i)
            continue
        if (o.get("due") or "") != (i.get("due") or ""):
            moved.append((i, o.get("due")))
        os_, ns = (o.get("sub") or {}).get("score"), (i.get("sub") or {}).get("score")
        if ns is not None and os_ is None:
            graded_new.append(i)

# ---- sanity gate ------------------------------------------------------------
dated_now = sum(1 for i in items if i.get("due"))
live = [v for v in (sync.get("courses") or {}).values()
        if isinstance(v, dict) and not v.get("err")]
fail = None
if RAW_N < 25 or RAW_DATED < 20:
    fail = "gradebook pull returned only %d items / %d dated" % (RAW_N, RAW_DATED)
elif prev_dated and RAW_DATED < 0.6 * prev_dated:
    fail = "dated gradebook items fell from %d to %d - refusing to overwrite" % (prev_dated, RAW_DATED)
elif not live:
    fail = "no course returned data"
elif prev_err is not None and [k for k in errored if k not in prev_err]:
    fail = "course(s) %s returned data yesterday and error today - not overwriting "\
           "until you know why" % ", ".join(k for k in errored if k not in prev_err)
if fail:
    sys.stderr.write("GATE FAIL: %s\n" % fail)
    with open(note_p, "w", encoding="utf-8") as fh:
        fh.write("Canvas sync failed: %s" % fail)
    sys.exit(2)

# ---- write --------------------------------------------------------------
term_end_dt = dt(meta.get("term_end") + "T23:59:00Z") if meta.get("term_end") else None
D["pacing"] = pace
D["coverage"] = coverage
D["health"] = dict(errored=errored, missed_days=missed, snapshots=len(hist),
                   orphans=[list(o) for o in orphans],
                   days_to_term_end=(term_end_dt - NOW).days if term_end_dt else None)
D["delta"] = dict(new=len(new_items), moved=len(moved), graded=len(graded_new),
                  merged=merged, raw_dated=RAW_DATED,
                  compared_to=os.path.basename(hist[-1]) if prev else None)
meta["built_at"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
with open(out_p, "w", encoding="utf-8") as fh:
    json.dump(D, fh)

L = []
L.append("# Morning brief - %s" % datetime.now(LOCAL).strftime("%a %d %b %Y, %H:%M %Z"))
L.append("")
if overdue:
    L.append("## Overdue and unsubmitted (%d)" % len(overdue))
    for i in overdue[:15]:
        late = CRS.get(i["c"], {}).get("late", "")
        L.append("- **%s** - %s - was due %s%s" %
                 (i["name"], i["c"], when(i["due"]),
                  ("  \n  _late rule:_ " + late) if late else ""))
else:
    L.append("## Overdue\nNothing. Every dated item that has come due is submitted.")
L.append("")
L.append("## Next 48 hours (%d)" % len(soon))
for i in soon:
    tag = "" if gradeable(i) else "  [no gradebook row]"
    L.append("- %s - **%s** - %s%s%s" % (when(i["due"]), i["name"], i["c"],
                                         (" - %g pts" % i["pts"]) if i.get("pts") else "",
                                         tag))
if not soon:
    L.append("- Nothing due inside 48 h.")
L.append("")
L.append("## Next 7 days (%d)" % len(upcoming))
for i in upcoming[:20]:
    L.append("- %s - %s - %s" % (dt(i["due"]).astimezone(LOCAL).strftime("%a %d %b"),
                                 i["name"], i["c"]))
if len(upcoming) > 20:
    L.append("- ...and %d more - see the dashboard." % (len(upcoming) - 20))
L.append("")
if new_items or moved or graded_new:
    L.append("## Changed since the last run")
    for i in new_items[:12]:
        L.append("- NEW - %s - %s - due %s" % (i["c"], i["name"], when(i["due"])))
    for i, old_due in moved[:12]:
        L.append("- MOVED - %s - %s - %s -> %s" % (i["c"], i["name"],
                                                   old_due or "none", i["due"] or "none"))
    for i in graded_new[:12]:
        L.append("- GRADED - %s - %s - %s pts" % (i["c"], i["name"], (i["sub"] or {}).get("score")))
    L.append("")
L.append("## Pace")
for key in ORDER:
    p = pace[key]
    g = p["grade"]
    L.append("- **%s** - %s - %d/%d due-so-far done - %d missing - %d in 7 d (%g pts) - "
             "%d left, ~%s/wk%s%s" %
             (key, p["verdict"], p["done"], p["past"], p["missing"], p["next7"],
              p["next7_pts"], p["remaining"], p["avg_per_week"],
              (" - grade %s%%" % g["score"]) if g and g.get("score") is not None else "",
              (" - %d dated, untracked" % p["untracked"]) if p["untracked"] else ""))
L.append("")
L.append("## Coverage audit - dated items are not the whole course")
for key in ORDER:
    cv = coverage.get(key)
    if not cv:
        continue
    line = "- **%s** - %d modules, %d readings/materials, %d unmet module requirements" % (
        key, cv["modules"], cv["materials"], cv["incomplete_requirements"])
    if cv["unmapped"]:
        line += "; **%d graded module items with no gradebook match**: %s" % (
            len(cv["unmapped"]), ", ".join(u[0] for u in cv["unmapped"][:4]))
    L.append(line)
L.append("")
due_maint = [(d, t) for d, t in MAINT
             if 0 <= (dt(d + "T12:00:00Z") - NOW).days <= 10]
if due_maint:
    L.append("## Upkeep due (this system, not your coursework)")
    for d, t in due_maint:
        L.append("- **%s** - %s" % (d, t))
    L.append("")

warn = []
if errored:
    warn.append("no data from: %s" % ", ".join(errored))
if missed:
    warn.append("no snapshot on %s" % ", ".join(sorted(missed)))
if orphans:
    warn.append("%d dated item(s) for course ids the transform does not know "
                "(%s) - add them to COURSES/ORDER or they stay invisible"
                % (len(orphans), ", ".join(sorted({o[0] for o in orphans}))))
if warn:
    L.append("## System health")
    for w in warn:
        L.append("- %s" % w)
    L.append("")

dleft = D["health"]["days_to_term_end"]
if dleft is not None:
    L.append("_%d days to %s._" % (dleft, meta.get("term_end")))
L.append("")
L.append("_%d items (%d dated, %d merged from discussions/calendar/pages/planner). "
         "Built %s._" % (len(items), dated_now, merged, meta["built_at"]))
with open(brief_p, "w", encoding="utf-8") as fh:
    fh.write("\n".join(L))

head = ("%d overdue - %d in 48h" % (len(overdue), len(soon))) if (overdue or soon) \
    else "Clear - nothing overdue, nothing in 48h"
if new_items or moved:
    head += " - %d new, %d moved" % (len(new_items), len(moved))
if len(missed) >= 2:
    head += " - missed %d of the last 7 mornings" % len(missed)
with open(note_p, "w", encoding="utf-8") as fh:
    fh.write(head)
print("data.json: %d items, %d dated, %d merged, gate PASS | %s" %
      (len(items), dated_now, merged, head))
