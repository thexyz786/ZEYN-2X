# dashboard/ — Zeyn Brief

A private daily brief on politics and world affairs for a serious reader with
Gulf and South Asian ties: geopolitics, political economy and trade, the Middle
East and South Asia, American law and policy, technology governance, a daily
analytical section on openings and gaps worth money, and two pieces of deeper
reading. It updates in the cloud on its own schedule and keeps every edition,
so a day away costs nothing. It carries no stock market or financial market
data and no American infotainment.

**Live page:** https://claude.ai/artifact/4PN5ySSbsgngispvgVquWN (private to the owner)

## How the system works

```
  07:20 PT daily          Claude routine "Zeyn Brief" (cloud, fresh session)
        │                 reads the last edition date → researches the gap
        ▼                 under source-policy.md → writes one JSON document
  Artifact database  ──►  collection `briefs`, doc id = YYYY-MM-DD
        │
        ▼
  brief.html          reads the collection live, shows the latest edition,
                      flags every edition published since you last opened it,
                      and keeps the archive one click away
```

Three properties follow from that shape:

1. **It runs without your laptop.** The routine is a server-side scheduled
   task in Claude Code. Nothing local has to be on.
2. **A missed day is never lost.** Each edition is a separate document. If a
   run fails, the next morning's run detects the gap, researches the whole
   period, marks itself a catch-up edition and opens with a "While you were
   away" paragraph. The page's catch-up strip lists every edition you have not
   yet opened, in order.
3. **You are told even if you never open the page.** The routine's closing
   note is delivered by push notification and email after each run.

## Files

| File | Purpose |
|---|---|
| `brief.html` | The dashboard page. Published as the artifact above. Declares the `db` and `user` capabilities; everyone with access reads, only the owner writes. |
| `routine-prompt.md` | The exact standing instruction the daily routine runs, including the compact source rules. Edit here, then update the routine's prompt to match. |
| `source-policy.md` | The researched outlet-by-outlet source policy: ownership, independent ratings, known failures, tiers, blocklist and corroboration rules. The authority behind the compact rules in the prompt. |
| `brief-schema.json` | JSON Schema for one edition. The page renders anything that fits it. |

## Sections

| key | Title | Rendered |
|---|---|---|
| `geo` | Geopolitics and conflict | main column |
| `econ` | Political economy and trade | main column |
| `mena` | Middle East, Gulf and South Asia | main column |
| `us` | American politics, law and policy | main column |
| `tech` | Technology governance and AI | main column |
| `opp` | Openings and gaps | main column, amber card, labelled analysis, with a doctrine line per item (R1 to R7 from `../01-conduct-code.md`) |
| `read` | Deeper reading | right-hand rail |

Plus a one-sentence headline, a five-line top line and a dated week ahead.

## Source policy in one paragraph

Wires and primary documents first. Then international outlets of record,
Al Jazeera English among them, each state-funded one carrying a named blind
spot that triggers a second-source rule. Regional outlets are admitted with
constraints: Gulf English dailies only for their own government's stated
position, Indian and Pakistani broadcasters never for military claims. Serious
US policy and legal outlets and California public-affairs outlets follow. Think
tanks and long-form fill the deeper-reading slot with their funders noted. An
explicit blocklist covers partisan cable, tabloids, outrage digital, state
propaganda and hyper-nationalist channels. Eight corroboration rules govern
casualties, sanctions, scoops, owners and funders. Details and evidence are in
`source-policy.md`.

## Network access

The routine's cloud environment allowlists the approved outlets by exact host,
so each needs its `www.` form where the site uses one. As tested on
5 October 2026:

- **Full text readable:** Al Jazeera, BBC, The Guardian, DW, NPR, PBS, The
  Hindu, Indian Express, The National, Haaretz, Al-Monitor, Los Angeles Times,
  Lawfare, SCOTUSblog, Foreign Affairs, Chatham House, Crisis Group, South
  China Morning Post, LAist, CalMatters.
- **Refused by the outlet's own server** (bot walls and paywalls): Reuters,
  AP, Financial Times, The Economist, France 24, New York Times, Wall Street
  Journal, Politico, Axios, Dawn, Times of Israel. The routine cites these
  from search results.
- **Still blocked by the allowlist:** www.washingtonpost.com and
  www.carnegieendowment.org. Check those two entries in the environment's
  network settings.

## Editing

- **Change the page:** edit `brief.html` and republish it to the URL above
  from a Claude Code session. The database is untouched by a republish.
- **Change the coverage or sources:** edit `routine-prompt.md` (and
  `source-policy.md` for the reasoning), then update the routine "Zeyn Brief"
  with the new prompt. Section keys are fixed in both the prompt and the page.
- **Change the time:** update the routine's cron. It is set to 07:20 Pacific
  so the edition is on file by 07:30; a run takes several minutes.
- **Pause:** disable the routine. The page keeps working on the archive.

## Freshness signal

The pill in the masthead reads the newest edition's timestamp: Current (under
26 hours), One day behind (26 to 50 hours), or the number of days without a
brief. A red pill means the routine did not run; check its run history.
