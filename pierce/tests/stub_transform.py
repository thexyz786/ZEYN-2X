#!/usr/bin/env python3
"""TEST DOUBLE - NOT the real dashboard-transform.py. Do not ship this.

The real stage-2 transform is hand-authored and carries the late-work rules,
drop risks, waypoints and Micro forecast rows. It is not in this repo. This
stub implements only the *contract* pacing.py depends on, so stages 3-5 can be
exercised end to end. Replace it with the real file before any live run; if the
real file's output disagrees with the contract asserted here, that disagreement
is the bug to fix, not this file.

Contract consumed by pacing.py:
  D["items"]   [{c,cid,id,name,kind,pts,due,unlock,lock,url,ext,attempts,
                 timelimit,sub{state,score,excused},src}]
  D["courses"] [{id (str), key, late}]         - order defines dashboard order
  D["grades"]  {key: {"score": float}}
  D["meta"]    {tz_school, tz_home, term_end, cinema_published}

usage: stub_transform.py sync.json data.raw.json
"""
import json, sys, re

sync_p, out_p = sys.argv[1], sys.argv[2]
with open(sync_p, encoding="utf-8") as fh:
    sync = json.load(fh)

# In the real transform these are hand-maintained blocks (spec 4.2: "Two edits,
# and only these two, when the term changes: COURSES and ORDER").
COURSES = {
    "372593": ("ACCTG",   "72h late at 70% credit; Cengage cutoff is hard"),
    "372967": ("COUNSEL", "no late work accepted"),
    "372991": ("ENGL",    "48h late, one letter grade off"),
    "373604": ("MICRO",   "labs cannot be made up"),
    "372230": ("POLSCI",  "72h late at 70% credit"),
    "373626": ("CINEMA",  "Not published yet"),
}
ORDER = ["ACCTG", "COUNSEL", "ENGL", "MICRO", "POLSCI", "CINEMA"]

items, grades = [], {}
for cid, key_late in COURSES.items():
    key, late = key_late
    c = (sync.get("courses") or {}).get(cid)
    if not isinstance(c, dict) or c.get("err"):
        continue
    for row in (c.get("a") or []):
        aid, name, due, unlock, lock, pts, stypes, st, score = (list(row) + [None] * 9)[:9]
        state = (st or "").split("@")[0].split("/")[0] or "unsubmitted"
        items.append(dict(
            c=key, cid=cid, id=aid, name=name, kind="quiz" if "Quiz" in (name or "")
            else "exam" if "Exam" in (name or "") else "homework",
            pts=pts, due=due, unlock=unlock, lock=lock,
            url="https://ilearn.laccd.edu/courses/%s/assignments/%s" % (cid, aid),
            ext="online_upload" not in (stypes or ""), attempts=None, timelimit=None,
            sub=dict(state=state, score=None if score in ("", None) else score,
                     excused="/exc" in (st or ""), late="/late" in (st or ""),
                     missing="/miss" in (st or "")),
            src="gradebook"))
    if c.get("grade") and c["grade"][0] is not None:
        grades[key] = {"score": c["grade"][0], "letter": c["grade"][1]}

D = dict(
    items=items,
    courses=[dict(id=cid, key=COURSES[cid][0], name=(sync.get("courses") or {})
                  .get(cid, {}).get("name") or COURSES[cid][0], late=COURSES[cid][1])
             for cid in COURSES
             if COURSES[cid][0] in ORDER],
    grades=grades,
    meta=dict(tz_school="America/Los_Angeles", tz_home="Asia/Kolkata",
              term_end="2026-12-20", cinema_published=False,
              source=sync.get("source"), pulled=sync.get("pulled")))
# ORDER controls dashboard order; the dict above is only keyed for lookup
D["courses"].sort(key=lambda c: ORDER.index(c["key"]))

with open(out_p, "w", encoding="utf-8") as fh:
    json.dump(D, fh)
print("data.raw.json: %d items, %d dated (STUB TRANSFORM - not the real one)"
      % (len(items), sum(1 for i in items if i.get("due"))))
