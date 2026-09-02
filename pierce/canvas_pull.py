#!/usr/bin/env python3
"""Stage 1 - pull the whole term out of Canvas into sync.json.

Same keys as the v1 browser snippet (a, q, g, grade, ann) so the existing
transform still reads it, plus discussions, modules, module items, pages,
calendar events, syllabus body, syllabus-ish files, and planner items - the
things that carry a deadline but no gradebook row.

Fail-closed by design: if an endpoint errors part-way through pagination the
whole endpoint is reported as an error rather than returned half-complete.
A half gradebook that looked healthy would defeat the stage-3 sanity gate.
"""
import json, os, re, sys, time, subprocess
import urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone

BASE       = "https://ilearn.laccd.edu"
COURSE_IDS = [372593, 372967, 372991, 373604, 373626, 372230]
WINDOW     = ("2026-08-01", "2027-01-15")
OUT        = sys.argv[1] if len(sys.argv) > 1 else "sync.json"
TIMEOUT    = 45

_HDRS = None


def get_token():
    t = os.environ.get("CANVAS_TOKEN")
    if t:
        return t.strip()
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-a", "canvas",
             "-s", "pierce-canvas-token", "-w"], text=True).strip()
    except Exception:
        sys.exit("FATAL: no token in $CANVAS_TOKEN or Keychain. See section 2.")


def hdrs():
    """Token is fetched on first use, not at import, so the module stays
    importable (and --help / compile checks stay runnable) without Keychain."""
    global _HDRS
    if _HDRS is None:
        _HDRS = {"Authorization": "Bearer " + get_token(),
                 "Accept": "application/json"}
    return _HDRS


def api(path, **params):
    """GET, following rel=next. Returns list, dict, or {'err': ...}."""
    url = BASE + path
    if params:
        url += ("&" if "?" in path else "?") + urllib.parse.urlencode(params, doseq=True)
    acc, page, hops = [], url, 0
    while page and hops < 12:
        body = link = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(page, headers=hdrs())
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    body = r.read().decode("utf-8", "replace")
                    link = r.headers.get("Link", "") or ""
                break
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404):
                    return {"err": e.code}
                if attempt == 2:
                    return {"err": "http %s" % e.code}
                time.sleep(2 * (attempt + 1))
            except Exception as e:
                if attempt == 2:
                    return {"err": str(e)[:80]}
                time.sleep(2 * (attempt + 1))
        if body is None:
            return {"err": "no body"}
        try:
            j = json.loads(body)
        except Exception:
            return {"err": "bad json"}
        if isinstance(j, dict):
            # Canvas answers some failures HTTP 200 with an {"errors": [...]}
            # body. Without this, callers iterate a dict and crash on .get().
            if "errors" in j or "error" in j:
                return {"err": str(j.get("errors") or j.get("error"))[:80]}
            return j
        acc += j
        nxt = [s for s in link.split(",") if 'rel="next"' in s]
        m = re.search(r"<([^>]+)>", nxt[0]) if nxt else None
        page = m.group(1) if m else None
        hops += 1
    return acc


TAGS = re.compile(r"<[^>]+>")
ENTS = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
        "&#39;": "'", "&nbsp;": " "}


def txt(html, n=400):
    s = TAGS.sub(" ", html or "")
    for k, v in ENTS.items():
        s = s.replace(k, v)
    return re.sub(r"\s+", " ", s).strip()[:n]


def ok(x):
    return not (isinstance(x, dict) and "err" in x)


def main():
    out = {"pulled": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "token", "courses": {}}

    me = api("/api/v1/users/self")
    if not ok(me):
        sys.exit("FATAL: /users/self returned %s - token rejected or expired." % me["err"])
    out["user"] = me.get("name")

    for cid in COURSE_IDS:
        key, c = str(cid), {}
        course = api("/api/v1/courses/%d" % cid, **{"include[]": ["syllabus_body", "term"]})
        if not ok(course):
            out["courses"][key] = {"err": course["err"]}
            continue
        c["name"] = course.get("name")
        c["state"] = course.get("workflow_state")
        c["syllabus"] = txt(course.get("syllabus_body"), 4000)

        A = api("/api/v1/courses/%d/assignments" % cid, per_page=100, order_by="due_at",
                **{"include[]": ["submission", "all_dates"]})
        if not ok(A):
            c["err"] = A["err"]
        else:
            rows = []
            for a in A:
                s = a.get("submission") or {}
                st = s.get("workflow_state") or ""
                if s.get("submitted_at"):
                    st += "@" + str(s["submitted_at"])[:10]
                if s.get("late"):
                    st += "/late"
                if s.get("missing"):
                    st += "/miss"
                if s.get("excused"):
                    st += "/exc"
                rows.append([a.get("id"), (a.get("name") or "").strip(), a.get("due_at"),
                             a.get("unlock_at"), a.get("lock_at"), a.get("points_possible"),
                             "|".join(a.get("submission_types") or []), st,
                             "" if s.get("score") is None else s.get("score")])
            c["a"] = rows
            # section-specific overrides: an assignment can be due later for your section
            c["dates"] = [[a.get("id"), [[d.get("due_at"), d.get("title")]
                                         for d in (a.get("all_dates") or [])]]
                          for a in A if len(a.get("all_dates") or []) > 1]

        Q = api("/api/v1/courses/%d/quizzes" % cid, per_page=100)
        if ok(Q):
            c["q"] = [[q.get("assignment_id"), q.get("id"), (q.get("title") or "").strip(),
                       q.get("due_at"), q.get("points_possible"), q.get("allowed_attempts"),
                       q.get("time_limit"), q.get("quiz_type")] for q in Q]

        G = api("/api/v1/courses/%d/assignment_groups" % cid, per_page=50)
        if ok(G):
            c["g"] = [[g.get("name"), g.get("group_weight")] for g in G if g.get("group_weight")]

        E = api("/api/v1/courses/%d/enrollments" % cid, user_id="self")
        if ok(E) and E and (E[0].get("grades") or {}):
            gr = E[0]["grades"]
            c["grade"] = [gr.get("current_score"), gr.get("current_grade")]

        AN = api("/api/v1/announcements", per_page=20, start_date=WINDOW[0], end_date=WINDOW[1],
                 **{"context_codes[]": ["course_%d" % cid]})
        if ok(AN):
            c["ann"] = [[a.get("posted_at"), (a.get("title") or "").strip(),
                         txt(a.get("message"), 320)] for a in AN[:8]]

        # --- everything v1 could not see -------------------------------------
        DSC = api("/api/v1/courses/%d/discussion_topics" % cid, per_page=100)
        if ok(DSC):
            c["disc"] = [[d.get("id"), (d.get("title") or "").strip(), d.get("assignment_id"),
                          d.get("todo_date") or d.get("lock_at"), d.get("posted_at"),
                          bool(d.get("published")), d.get("html_url"),
                          txt(d.get("message"), 200)] for d in DSC]

        M = api("/api/v1/courses/%d/modules" % cid, per_page=100, **{"include[]": ["items"]})
        if ok(M):
            c["mod"] = []
            for m in M:
                its = []
                for i in (m.get("items") or []):
                    cr = i.get("completion_requirement") or {}
                    its.append([i.get("id"), (i.get("title") or "").strip(), i.get("type"),
                                i.get("content_id"), i.get("html_url"), cr.get("type"),
                                bool(cr.get("completed")), bool(i.get("published", True))])
                c["mod"].append([m.get("id"), (m.get("name") or "").strip(), m.get("state"),
                                 m.get("unlock_at"), m.get("workflow_state"), its])

        P = api("/api/v1/courses/%d/pages" % cid, per_page=100, sort="updated_at", order="desc")
        if ok(P):
            c["pages"] = [[p.get("url"), (p.get("title") or "").strip(), p.get("todo_date"),
                           p.get("updated_at")] for p in P[:60]]

        CAL = api("/api/v1/calendar_events", per_page=100, type="event",
                  start_date=WINDOW[0], end_date=WINDOW[1],
                  **{"context_codes[]": ["course_%d" % cid]})
        if ok(CAL):
            c["cal"] = [[e.get("id"), (e.get("title") or "").strip(), e.get("start_at"),
                         e.get("end_at"), e.get("html_url")] for e in CAL]

        F = api("/api/v1/courses/%d/files" % cid, per_page=100)
        if ok(F):
            pat = re.compile(r"syllab|schedule|calendar|outline|rubric|checklist", re.I)
            c["files"] = [[f.get("display_name"), f.get("updated_at"),
                           (f.get("url") or "").split("?")[0]]
                          for f in F if pat.search(f.get("display_name") or "")][:20]

        out["courses"][key] = c

    PL = api("/api/v1/planner/items", per_page=100, start_date=WINDOW[0], end_date=WINDOW[1])
    if ok(PL):
        rows = []
        for p in PL:
            pl = p.get("plannable") or {}
            sub = p.get("submissions")
            rows.append([p.get("plannable_type"), pl.get("id"), p.get("course_id"),
                         (pl.get("title") or pl.get("name") or "").strip(),
                         p.get("plannable_date"), p.get("html_url"),
                         bool(sub.get("submitted")) if isinstance(sub, dict) else False])
        out["planner"] = rows

    TD = api("/api/v1/users/self/todo", per_page=100)
    if ok(TD):
        out["todo"] = [[t.get("type"), ((t.get("assignment") or {}).get("name") or "").strip(),
                        (t.get("assignment") or {}).get("due_at"), t.get("html_url")] for t in TD]

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    live = [v for v in out["courses"].values() if isinstance(v, dict) and not v.get("err")]
    print("sync.json: %d/%d courses live, %d assignments, %d bytes"
          % (len(live), len(COURSE_IDS),
             sum(len(v.get("a") or []) for v in live), os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
