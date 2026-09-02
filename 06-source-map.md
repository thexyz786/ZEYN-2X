---
title: Source Map — provenance, coverage, and the intake queue
status: LIVING — the intake queue should always have entries
rev: 2
opened: 2026-08-26
last_intake: 2026-08-27 — dbdea.org transcript, supplied by Hatim
end_goal: Known coverage. An unread source is a known unknown, not an unknown one.
---

# 06 — SOURCE MAP

> **How this file grows.** Every scrape session appends: what was read, what was
> blocked, what was found. The **Intake Queue** at the bottom must never be
> empty — when it empties, the knowledge base has stopped growing, and a
> knowledge base that has stopped growing is decaying.

---

## Scrape session 1 — 2026-08-26

### tijaaratraabehah.org — **substantially complete**

**Organisation.** Idaarah al-Tijaarat al-Raabehah ("profitable trade"), a
business-upliftment platform for the Dawoodi Bohra community, operating under
the leadership of al-Dai al-Ajal **Syedna Mufaddal Saifuddin TUS**. Sits under
**Umoor Iqtesadiyah** (the community's economic-affairs department — evidenced by
its Instagram handle `@umoor.iqtesadiyah`; the site never states the relationship
in prose). Funding partner: **The Saifee Foundation**, established on Lailatul
Qadr **1378 H / 1959** by the 51st al-Dai al-Mutlaq, **Dr. Syedna Taher
Saifuddin RA**. Office: Taj Building B2, Dr. D. N. Road, Fort, Mumbai 400001.

**Pages read: ~50 distinct URLs**, including all seven core programme pages, the
legacy homepage `/home-old/` (the single richest page for figures and conduct
rules), `/setup-home-industry/`, `/counseling`, `/partnership/`, `/tradedesk`,
`/templates`, `/business-maturity/`, `/business-plan/`, `/dbohra/`, plus **22
distinct article pages** across `/business/`, `/branding/`, `/ecommerce/` and
`/uncategorized/`.

**Blocked (403 to crawlers):** `/lms/` and the LMS course bodies · `/dua-araz/` ·
`/setup-industry` · `/counselling-2/` · `/category/entrepreneurship/` · the
sitemap · several individual article slugs.

**Known coverage gap — material.** The author archive `/author/it-hqhb/`
paginates to **page 57** and `/category/business/` to **36 pages**. The 22
articles captured are a representative sample, not the corpus. The largest
unread cluster is a newer paired case-study series (Mamaearth, Infosys, Nykaa,
colour psychology in branding, employer branding, UX, compensation design) — and
that cluster is the one most likely to carry concrete company figures, which the
older evergreen articles largely lack.

**Internal inconsistencies found, reported not reconciled:**
- Counselling pricing: `/home-old/` publishes tiers from ₹1,100 to ₹99,999;
  the current `/counseling` says the first call is free and withholds rates.
- Counsellor rosters differ entirely between `/counseling` and
  `/business-counseling/` — different six names, different volumes.
- Business counts conflict: 21,900+ (`/home-old/`) vs 1,000+ (`/dbohra/`).
- Trade Desk deed counts overlap oddly with partnership deed counts.
- Shabbir Bhai is a carpet business on one page and a Rida/Masallah business on
  another, with different reported gains (5% vs 23%).

**Absent from every page read:** no Quranic verse or hadith text quoted; no
Arabic primary text. All religious grounding is via attributed sayings of the
Duat. The words *halal*, *haram*, *riba* do not appear — interest is *viyaaj*.
No named leadership, board, or staff for the Idaarah itself; only counsellors
and testimonial subjects. No founding date for the Idaarah — only for the Saifee
Foundation (1959) and TAP (2016).

### dbdea.org — **RESOLVED 2026-08-27.** Read via transcript supplied by Hatim.

**DBDEA = the Dawoodi Bohra Department of Economic Affairs = Umoor Iqtesadiyah.**
The candidate expansion flagged as unverified in rev 1 is confirmed correct, and
the structural relationship inverts what rev 1 assumed: **DBDEA is the parent,
and Tijaarat Raabehah is one of four arms beneath it** — alongside Qardan
Hasana, The Saifee Foundation, and DBohra Business Solutions. Full treatment in
Register 05.

Tagline as published: empowering economic progress through business support,
financial access, and values-driven development.

**Why automated retrieval failed — two independent causes, both real:**

1. **robots.txt** (directly observed): Cloudflare's managed block list with
   `ClaudeBot` disallowed by name, alongside GPTBot, CCBot, Google-Extended and
   others, under a content signal of `ai-train=no`. This was honoured — no
   proxy, no cache mirror, no workaround.
2. **The site is a React SPA** (per the transcript): server HTML is a title,
   meta tags and an empty `#root`. All copy loads from lazy Vite chunks, behind
   a Cloudflare bot challenge. Even an unblocked simple GET returns no body
   copy — only a rendering browser sees the page.

Either cause alone would defeat a fetcher. Together they explain the total
absence of any public index or archive footprint.

**Registration data from rev 1 stands** and now reads differently: created
2025-07-11, Cloudflare, active Google Workspace mail, strict `p=reject` DMARC,
zero Wayback captures. Not an abandoned shell — a **new department-level site**
built roughly thirteen months ago and deliberately kept out of AI indexes.
The `Disallow: /under-development` path is confirmed by the transcript as a real
route: the placeholder for pages not yet finished.

**Corrections to rev 1 arising from this intake:**
- Qardan Hasana's domain is **qardanhasana.org**, not `.info` as recorded in rev 1.
- The Saifee Foundation has its own site: **thesaifeefoundation.org**.
- Canonical host is **www.dbdea.org**; rev 1 recorded that host as NXDOMAIN at
  the time of the DNS check. Either DNS has changed since, or the canonical and
  the resolving host differ. Unresolved — flagged, not reconciled.
- Rev 1 reported "no named leadership or staff anywhere in the ecosystem." The
  DBDEA Tijaarat page carries a support-staff block naming four Sadriwala
  brothers — Taha, Mustafa, Taizoon and Abbas bhai Shk Mufaddal bhai Sadriwala.

**Known routes on the domain:** `/` (a single long page), `/tijaarat-Raabehah`,
`/qardan-hasana`, `/under-development`.
**Nav:** Home · About Us · Our Vision · Goals · Contact Us.
**Still unread:** About Us, Our Vision, and Goals were not in the transcript.

---

## Confirmed ecosystem map

| Property | Function |
|---|---|
| tijaaratraabehah.org | The doctrine and programme hub |
| umooriqtesadiyah.org | Parent: economic-affairs department |
| dbohra.com | Global trade portal, verified-community profiles |
| learning.dbohra.com | LMS — courses and certificates |
| counseling.dbohra.com | Counselling booking and business-plan tool |
| partnership.tijaaratraabehah.org | Shariat-compliant deed creation |
| incubation.tijaaratraabehah.org | 6-week virtual incubation |
| tred.tijaaratraabehah.org | Digital branding and transformation |
| forums.tijaaratraabehah.org | Community forums |
| saifeeburhaniexpo.org | Expos and exhibitions |
| dbdea.org | **The parent department** — DBDEA / Umoor Iqtesadiyah |
| qardanhasana.org | Interest-free lending — the capital arm |
| thesaifeefoundation.org | MSME support, microfinance, skills |
| publications.dbohra.com | Newsletters and blogs |

---

## Intake Queue
*(never let this empty)*

- [ ] **The three Fatemi Philosophy booklets** (`/templates`) — on attaining
      livelihood, on manufacturing, historical. Highest doctrinal value outstanding.
- [ ] LMS **Business Ethics** course body — crawler-blocked; accessible by enrolling.
- [ ] LMS **Partnerships according to Shariat** course body.
- [ ] The `/author/it-hqhb/` archive, pages 2–57.
- [ ] The newer case-study series (Mamaearth, Infosys, Nykaa, employer branding).
- [ ] `publications.dbohra.com/newsletters` and `/blogs`.
- [ ] **dbdea.org** — via browser, by the user.
- [ ] Resolve the "IDD" expansion.
- [ ] Resolve what TR Solutions / TR Network / TR Learning formally denote.
- [ ] **Is there a Zonal Business Council covering Los Angeles or the US?**
      The single most actionable open question in the whole base.
