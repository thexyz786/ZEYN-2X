#!/usr/bin/env python3
"""Build a synthetic sync.json shaped exactly like canvas_pull.py's output.

FABRICATED DATA. Course names, assignment titles and grades are invented.
This exists so stages 2-5 can be exercised without touching Canvas, which is
unreachable from any cloud container. Dates are generated relative to today so
the fixture never goes stale.

usage: make_fixture.py out.json [--collapse] [--err COURSE_ID ...]
  --collapse   emit a near-empty gradebook, to prove the stage-3 gate fires
  --err ID     force a course to return an error, to prove the health canary
"""
import json, sys, random
from datetime import datetime, timezone, timedelta

NOW = datetime.now(timezone.utc)


def iso(days, hour=23, minute=59):
    d = (NOW + timedelta(days=days)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


COURSES = [
    (372593, "ACCTG 001 - Introductory Accounting I", "ACCTG", 26, 88.4),
    (372967, "COUNSEL 040 - College Success", "COUNSEL", 18, 94.0),
    (372991, "ENGLISH 101 - College Reading and Composition", "ENGL", 24, 81.2),
    (373604, "MICRO 001 - Introductory Microbiology", "MICRO", 34, 79.5),
    (372230, "POL SCI 001 - Government of the United States", "POLSCI", 22, 90.1),
    (373626, "CINEMA 107 - Motion Picture Appreciation", "CINEMA", 0, None),
]

KINDS = ["Homework", "Quiz", "Lab", "Discussion Post", "Reading Check", "Exam", "Essay"]


def build(collapse=False, forced_err=()):
    rng = random.Random(20260902)          # deterministic: same fixture every run
    out = {"pulled": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "fixture",
           "user": "Hatim Zainuddin", "courses": {}}
    planner = []

    for cid, name, key, n, grade in COURSES:
        k = str(cid)
        # CINEMA 107 is an unpublished shell until ~26 Oct: Canvas answers 403.
        if cid in forced_err or n == 0:
            out["courses"][k] = {"err": 403}
            continue

        c = {"name": name, "state": "available",
             "syllabus": "Synthetic syllabus body for %s. Late work accepted up to "
                         "72 hours at 70%% credit. Cengage access required." % key}

        rows, start = [], -42
        count = 2 if collapse else n
        for i in range(count):
            # spread due dates from six weeks ago to ten weeks out
            due_day = start + int(i * (112.0 / max(1, count)))
            kind = KINDS[i % len(KINDS)]
            past = due_day < 0
            # a couple of deliberate misses in MICRO so 'behind' verdict is exercised
            miss = past and key == "MICRO" and i in (3, 7)
            if past and not miss:
                st, score = "graded@%s" % iso(due_day - 1)[:10], round(rng.uniform(6, 10), 1)
            else:
                st, score = "unsubmitted", ""
                if miss:
                    st = "unsubmitted/miss"
            rows.append([900000 + cid % 1000 * 100 + i, "%s %02d - %s" % (key, i + 1, kind),
                         iso(due_day), iso(due_day - 7), iso(due_day + 3), 10.0,
                         "online_upload", st, score])
        c["a"] = rows
        c["dates"] = [[rows[0][0], [[rows[0][2], "Everyone else"],
                                    [iso(start + 2), "Section 2 (yours)"]]]] if rows else []

        c["q"] = [[rows[1][0], 5000 + i, rows[1][1], rows[1][2], 10.0, 2, 30, "assignment"]] \
            if len(rows) > 1 else []
        c["g"] = [["Homework", 40], ["Exams", 45], ["Participation", 15]]
        if grade is not None:
            c["grade"] = [grade, None]
        c["ann"] = [[iso(-3, 9, 0), "%s week ahead" % key,
                     "Reminder: the midterm study guide is posted."]]

        # --- dated things with no gradebook row: the whole point of v2 --------
        c["disc"] = [
            # graded discussion - already has a gradebook row, must NOT double-count
            [7100 + i, rows[3][1], rows[3][0], iso(4), iso(-10), True,
             "https://ilearn.laccd.edu/courses/%d/discussion_topics/7100" % cid, "graded"]
            if len(rows) > 3 else [7100, "x", None, None, None, False, "", ""],
            # ungraded but dated - this is what v1 could not see
            [7200 + i, "%s - ungraded intro thread" % key, None, iso(3), iso(-14), True,
             "https://ilearn.laccd.edu/courses/%d/discussion_topics/7200" % cid, "say hello"],
            # unpublished - must be ignored
            [7300 + i, "%s - draft thread" % key, None, iso(5), None, False, "", ""],
        ]
        c["cal"] = [
            [8100, "%s Midterm Exam (proctored)" % key, iso(9, 14, 0), iso(9, 16, 0),
             "https://ilearn.laccd.edu/calendar"],
            [8200, "%s office hours" % key, iso(1, 15, 0), iso(1, 16, 0), ""],
        ]
        c["pages"] = [
            ["week-08-checklist", "%s Week 8 checklist" % key, iso(6), iso(-2)],
            ["course-policies", "%s course policies" % key, None, iso(-30)],
        ]
        c["files"] = [["%s_syllabus_F26.pdf" % key, iso(-40),
                       "https://ilearn.laccd.edu/files/1"],
                      ["%s_rubric.docx" % key, iso(-35), "https://ilearn.laccd.edu/files/2"]]

        # modules, including one PLANTED graded item with no gradebook row -
        # the exact failure this system exists to catch
        c["mod"] = [
            [1, "Week 1-4", "completed", None, "active", [
                [11, rows[0][1], "Assignment", rows[0][0], "", "must_submit", True, True],
                [12, "%s lecture slides" % key, "File", 1, "", None, False, True],
                [13, "%s textbook reading" % key, "Page", 2, "", "must_view", True, True],
            ]],
            [2, "Week 5-8", "started", None, "active", [
                [21, "Hidden Module Quiz - %s" % key, "Quiz", 9999, "",
                 "must_submit", False, True],                       # <- the planted miss
                [22, "%s supplementary video" % key, "ExternalUrl", 3, "", None, False, True],
                [23, "%s unpublished draft" % key, "Assignment", 4, "", None, False, False],
            ]],
        ]

        out["courses"][k] = c

        # planner: one unsubmitted item that has no gradebook row at all
        planner.append(["planner_note", 6100 + cid % 100, cid,
                        "%s - reading response (planner only)" % key, iso(2),
                        "https://ilearn.laccd.edu/courses/%d" % cid, False])
        # and one already submitted, which must be skipped
        planner.append(["assignment", 6200 + cid % 100, cid, rows[0][1], rows[0][2],
                        "", True])

    # a planner item for a course the transform does not know about - exercises
    # the orphan path rather than vanishing silently
    planner.append(["assignment", 6999, 999999, "PHANTOM 101 - untracked course work",
                    iso(3), "", False])

    out["planner"] = planner
    out["todo"] = [["submitting", "ACCTG 05 - Reading Check", iso(2), ""]]
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    outp = args[0]
    collapse = "--collapse" in args
    errs = set()
    if "--err" in args:
        for a in args[args.index("--err") + 1:]:
            if a.startswith("--"):
                break
            errs.add(int(a))
    d = build(collapse, errs)
    with open(outp, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    live = [v for v in d["courses"].values() if not v.get("err")]
    print("fixture %s: %d/%d courses live, %d assignments"
          % (outp, len(live), len(COURSES), sum(len(v.get("a") or []) for v in live)))
