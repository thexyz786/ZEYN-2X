# Pierce Daily — build status

Implements `claude_piercedailysystem.md` v2. **Not yet runnable against live
Canvas**: two of the five files are missing and stage 1 has never touched the
real API.

## What is here

| File | Stage | Status |
|---|---|---|
| `canvas_pull.py` | 1 — Canvas → `sync.json` | written, compile-clean, **never run live** |
| `dashboard-transform.py` | 2 — `sync.json` → `data.raw.json` | **MISSING** — hand-authored, lives on the Mac |
| `pacing.py` | 3 — merge, pace, gate, brief | written, tested |
| `dashboard-template.html` | 4 — renderer | **MISSING** — lives on the Mac |
| `pierce-daily.sh` | the chain | written, tested |
| `com.hatim.pierce-daily.plist` | 07:00 job | written, valid |
| `tests/` | harness | 19 checks, all passing |

`tests/stub_transform.py` and `tests/stub_template.html` are **test doubles**,
not replacements. They implement only the contract stage 3 depends on, so the
pipeline could be exercised. Copy the real files in before any live run.

## Contract stage 3 depends on

`dashboard-transform.py` must emit:

```
D["items"]   [{c, cid, id, name, kind, pts, due, unlock, lock, url, ext,
               attempts, timelimit, sub{state, score, excused}, src}]
D["courses"] [{id, key, late}]        order defines dashboard order
D["grades"]  {key: {"score": float}}
D["meta"]    {tz_school, tz_home, term_end, cinema_published}
```

Stage 3 now coerces every `cid` to `str` on both sides, so an int/str mismatch
between the transform and Canvas can no longer silently orphan items.

## Bugs found and fixed

Ordered by what they would have cost.

1. **The 07:00 job would never have run.** The plist in §4.5 puts an XML
   comment *before* the `<?xml?>` declaration. That is not well-formed XML;
   `launchctl load` refuses it. Confirmed by `plistlib`, then fixed.
2. **Every course would have read "behind" by about week 6.** Merged
   discussions, calendar events and dated pages carry no submission record, but
   the pace maths counted any past unsubmitted dated item as missing. A term's
   worth of past office hours made the brief report **52 overdue** against
   2 real gradebook misses, and pinned all five courses at "behind". Fixed:
   only gradebook-sourced items can be "missing" (`gradeable()`); calendar
   furniture is excluded from workload (`workload()`); untracked dated items
   are counted and disclosed per course rather than hidden. Regression test T7.
3. **Silent empty dashboard.** Injection used `replace(marker, data, 1)`, which
   takes the *first* hit — so a template that merely names the marker in a
   comment swallows the payload, and the `assert len(out) > len(tpl)` guard
   still passes. Hit this for real during testing. Now requires exactly one
   marker or refuses. Regression test T3.
4. **Crash on any date-only field.** `dt()` returned naive datetimes for values
   like `2026-09-10`; comparing one to `NOW` raises `TypeError` and kills the
   build. Naive is now assumed UTC, with a fallback parser for Python 3.9/3.10.
5. **Crash on a Canvas 200-with-errors body.** `api()` returned such a dict
   as data; callers then iterated its keys and died on `.get()`. Now detected.
6. **Planner items for unknown courses vanished.** The `cid in KEY` guard
   dropped them before `add()` saw them. They are now recorded as orphans and
   named in the brief — the invisible-deadline case the system exists to catch.
7. **`flock` is Linux-only** — the lock would have been a no-op on macOS.
   Replaced with an atomic `mkdir` lock with stale-PID recovery.
8. Smaller: token fetched at import (module unimportable without Keychain);
   no `encoding=` on any file open; `weeks` computed with an `and`/`or` idiom
   that collapsed to 1.0 unexpectedly; transform failure not distinguished from
   gate failure in the chain; stale `sync.new.json` left after a failed pull;
   `logs/` never pruned; HTML entities left unescaped in `txt()`.

## Test run — 2 Sep 2026 (synthetic)

`bash tests/run_e2e.sh` — 19 checks, 0 failures. Fabricated payloads;
`ilearn.laccd.edu` is blocked by network policy in any cloud container
(confirmed: proxy answers 403 to CONNECT).

| Check | Result |
|---|---|
| stage 1, 3 compile; chain parses; plist valid | clean |
| cold build, no history | 124 gradebook items → 149 after merge, 25 merged |
| coverage audit | caught the planted "Hidden Module Quiz" in all 5 live courses |
| orphan detection | caught the planner item for an untracked course |
| injection into template | 72 101 bytes, payload verified as JSON at the marker |
| headless render | 7 table rows, **no console errors** |
| gate, collapsed pull | exit 2, nothing written, notification produced |
| gate, course live yesterday / erroring today | exit 2, cause named |
| warm rerun with history | exit 0 |
| aged term (8 weeks of past calendar events) | 2 missing, not 52 |

## Still unproven

Token issuance (§1), whether the new endpoints return anything on these
specific shells, real `sync.json` size once modules and pages are real, and
`launchd` firing on a sleeping Mac. Run §5 by hand once and record the numbers.
