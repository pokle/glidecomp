# GlideComp Security Review

GlideComp's code is reviewed for security on a regular cycle, by the
`/security-review-repo` routine (`.claude/commands/security-review-repo.md`).
To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is published here, and what is not

This repository is public, so **open findings are not published.** The
working log (every finding with its evidence, the scope gaps, and one write-up
per review round) is kept in a private repository. A finding is listed here
once its fix is **deployed**, not merely merged.

Until 2026-10-01 the whole log, open findings included, lived in this file and
in `docs/security-review/rounds/`. Those versions remain in this repository's
git history, so the findings that were open on that date are treated as
disclosed and are being fixed first.

## Fixed findings

| ID | Finding | Fixed |
|----|---------|-------|
| SEC-01 | Credentialed CORS reflected any origin | 2026-04-20 |
| SEC-02 | No security response headers on the site | 2026-05-25 |
| SEC-04 | IGC uploads were not checked for an IGC file's shape | 2026-06-08 |
| SEC-06 | No size cap on JSON request bodies | 2026-06-12 |
| SEC-08 | Rate-limited responses did not say when to retry | 2026-06-11 |
| SEC-10 | Authentication bypass through a trusted internal header | 2026-05-04 |
| SEC-11 | Decompression bomb in IGC uploads | 2026-05-04 |
| SEC-12 | No shape, depth or size limit on task (`xctsk`) bodies | 2026-05-04 |
| SEC-13 | Unsanitised file names from the share target | 2026-06-01 |
| SEC-15 | Pilots' personal details on the public pilot list | 2026-05-11 |
| SEC-16 | Vulnerable `kysely` dependency (JSON-path traversal) | 2026-05-18 |
| SEC-17 | Vulnerable `qs` and `ws` dependencies | 2026-05-25 |
| SEC-18 | Vulnerable `shell-quote` dependency | 2026-06-11 |
| SEC-20 | Task parser crashed on malformed input | 2026-06-21 |
| SEC-21 | Compressed-task parser crashed on malformed input | 2026-06-21 |
| SEC-22 | Stored XSS through a pilot's name in score tables and the map | 2026-07-03 |
| SEC-23 | Stored XSS through a turnpoint name in the 3D replay | 2026-07-03 |
| SEC-24 | Username placed in a link without encoding (super-admin page) | 2026-07-03 |
| SEC-28 | Spreadsheet formula injection in the pilots CSV export | 2026-07-29 |
| SEC-30 | Open redirect after sign-in | 2026-07-19 |
| SEC-32 | Slow altitude cleaning on crafted IGC timestamps | 2026-08-03 |
| SEC-33 | Slow track-quality check on crafted IGC timestamps | 2026-08-03 |
| SEC-34 | Build- and test-time dependency advisories | 2026-09-23 |
| SEC-35 | 3D replay data cached publicly for signed-in viewers | 2026-07-28 |
| SEC-36 | Spreadsheet formula injection in the CIVL rankings CSV | 2026-07-29 |
| SEC-37 | Registration route ignored a hidden test competition | 2026-08-12 |
| SEC-38 | Upload, manual-flight and pilot-status routes ignored a hidden test competition | 2026-08-12 |
| SEC-39 | Anonymous-submission limits could be spent by anyone | 2026-08-06 |
| SEC-41 | Stored XSS through waypoint and event names on the analysis page | 2026-08-12 |
| SEC-42 | Unchecked external link in official results | 2026-08-12 |
| SEC-43 | Spreadsheet formula injection in the route editor's CSV export | 2026-08-12 |
| SEC-44 | Three pilot fields changed without an audit-log entry | 2026-08-12 |
| SEC-46 | Slow circle detection on crafted IGC timestamps | 2026-08-17 |
| SEC-47 | Stored XSS through a pilot's name in the flight panel | 2026-08-17 |
| SEC-48 | Dependency advisories (`qs`, `fast-uri`, `browserslist`) | 2026-09-02 |
| SEC-49 | Account display names skipped the name checks | 2026-09-09, extended 2026-10-01 by SEC-55 |
| SEC-50 | Dependency advisories, one critical | 2026-09-09 |
| SEC-51 | Spreadsheet formula injection in the public waypoints CSV | 2026-09-23 |
| SEC-52 | Dependency advisories, four high | 2026-09-30 |
| SEC-55 | The sign-in service exposed library endpoints the app never used | 2026-10-01 |
| SEC-56 | Email sign-in codes could be guessed by a distributed attacker | 2026-10-01 |

**Closed without a fix:** SEC-09 (`Math.random()` used where nothing depends on
it being unpredictable), SEC-14 (a misleading code comment), SEC-19
(superseded by SEC-34), SEC-25 (the affected file was deleted).

**Accepted by design:** SEC-03 (a competition's admins' email addresses appear
on its public page) and SEC-54 (a session signed out on another device keeps
working for up to five minutes, the life of the session cache).
