# dashboard/ — Zeyn Brief

A private daily intelligence dashboard: world affairs, American policy and
law, markets, and Los Angeles. It updates in the cloud on its own schedule and
keeps every edition, so a day away costs nothing.

**Live page:** https://claude.ai/artifact/4PN5ySSbsgngispvgVquWN (private to the owner)

## How the system works

```
  07:20 PT daily          Claude routine "Zeyn Brief" (cloud, fresh session)
        │                 reads the last edition date → researches the gap →
        ▼                 writes one JSON document per day
  Artifact database  ──►  collection `briefs`, doc id = YYYY-MM-DD
        │
        ▼
  brief.html          reads the collection live, shows the latest edition,
                      flags everything published since you last opened it,
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
| `routine-prompt.md` | The exact standing instruction the daily routine runs. Edit here, then update the routine's prompt to match. |
| `brief-schema.json` | JSON Schema for one edition. The page renders anything that fits it. |

## Editing

- **Change the page:** edit `brief.html` and republish it to the URL above
  from a Claude Code session (the Artifact tool, same URL). The database is
  untouched by a republish.
- **Change the coverage:** edit `routine-prompt.md`, then update the routine
  "Zeyn Brief" with the new prompt. Sections carry fixed keys (`geo`, `econ`,
  `mena`, `tech`, `us`, `la`); add a key to both the prompt and the page if
  you add a section. The `la` section renders in the right-hand rail.
- **Change the time:** update the routine's cron. It is set to 07:20 Pacific
  so the edition is on file by 07:30; a run takes several minutes.
- **Pause:** disable the routine. The page keeps working on the archive.

## Freshness signal

The pill in the masthead reads the newest edition's timestamp:
Current (under 26 hours), One day behind (26 to 50 hours), or the number of
days without a brief. A red pill means the routine did not run; check its
run history in Claude Code.
