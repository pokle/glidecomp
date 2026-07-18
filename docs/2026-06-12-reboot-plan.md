# Reboot Plan — Launch v1

**Decision date:** 2026-06-12 · **Launch date:** 2026-07-01 (fixed, not negotiable)

## Verdict

Do not start again. Do not delete code. Five months in (since 2026-01-09,
467 commits), the project is ~85% of a complete product, deployed at
glidecomp.com with CI/CD and a well-tested engine. One restart already
happened — the native macOS direction (Feb 2026, tagged `macos/final`) —
and the lesson is that changing the vehicle doesn't produce a launch.

The problem is not the codebase, and not maintenance (deps/security run as
automated agents at near-zero cost). It is that "launch" was never defined,
so the project can look healthy and tended indefinitely without ever being
announced — commit velocity decayed from 196 (Jan) to 8 (Jun) while the
audience stayed at zero. This document is the bounding box.

## The wedge (one pitch, chosen from three)

Pitches considered:

1. **Solo flight analysis tool** — crowded space (SeeYou, XCTrack, Ayvri heirs).
2. **Competition management platform** — hard sales cycle; organizers adopt
   tools slowly and the stakes of a mis-scored comp are high. Wrong first move.
3. **"Understand your comp score"** — after every task, every comp pilot
   wonders why they got the points they got. No existing tool explains GAP
   scoring decisions. GlideComp's engine was built around explainability from
   day one. **← This is the launch.**

**One-line pitch:** *Drop your comp task IGC in your browser and see exactly
how your GAP score is computed — every distance, time, leading, and arrival
point, explained.*

## v1 bounding box

**In (all already built):**

- `analysis.html` — drag-drop IGC + task, events on map, works without login
- GAP score breakdown with explanations
- `scoring.html` — the scoring guide (supports the pitch)
- Google login + save flights (`dashboard.html`, profile, onboarding, legal)

**Shipped but not marketed (leave deployed, zero further investment):**

- Competition management — keep alive, label "beta", use it yourself to score
  one real comp as the future case study
- MCP server, AirScore proxy, theme editor

**Explicitly parked (post-launch backlog — tracked in
[GitHub issues](https://github.com/pokle/glidecomp/issues)):**

- Email IGC submission, aggregated cross-pilot analysis, score-explanation
  map overlay, box plots, R2 queue cleanup, Leaflet alpha.2 migration

**Swap rule:** nothing enters the v1 box unless something leaves it.

## Constraint rules (standing, post-launch too)

1. **Tending is not progress:** automated maintenance (deps, security
   reviews) stays automated and doesn't count as working on the project.
   The only measure of progress until 2026-07-01 is launch-checklist items.
2. **Launch-blocker test:** before starting any task ask "does v1 fail without
   this?" If no, it goes to the parked list.
3. **Feedback before features:** after 2026-07-01, no new feature work until
   10 real pilots have used it and said what's missing.

## Launch checklist (the only work between now and 2026-07-01)

- [ ] Rewrite `index.html` landing copy around the wedge pitch, with a
      "try it now — no account needed" path straight into analysis
- [ ] One worked example: a real task (Corryong Cup fixtures exist in the
      repo) loadable as a demo so visitors see value before uploading anything
- [ ] A 60–90 second screen recording of drop-IGC → explained score
- [ ] Verify the anonymous analysis flow end-to-end on mobile Safari and
      desktop (E2E already covers the logged-in paths)
- [ ] Post in 2–3 specific places where comp pilots are (national HG/PG
      association forums/groups, comp Telegram/WhatsApp groups) — not a
      generic "Show HN"
- [ ] Anything else discovered along the way goes to the parked list, not
      the checklist

## Press release (the bounding box, written first)

> **GlideComp: finally understand your competition score**
>
> Every comp pilot has stared at a results sheet wondering where the points
> went. You flew well, you made goal — so why is there a 40-point gap to the
> pilot who landed next to you?
>
> GlideComp answers that question. Drop your IGC track and the task file into
> your browser and it shows your flight on the map — every thermal, every
> glide — and computes your CIVL GAP score the same way the official scorer
> does. But unlike the results sheet, it explains itself: how task validity
> was derived, why your leading points came out where they did, what the time
> points cost you on that slow third leg.
>
> Everything runs in your browser. Your track is not uploaded anywhere unless
> you create an account to save it. It is free, and the scoring engine is
> tested against the FAI Sporting Code Section 7F (2024).
>
> GlideComp is built by a pilot, for pilots who want to get better at comps —
> because you can't improve what you can't see.
>
> Try it at glidecomp.com — no account needed.

Any future feature must fit inside this press release or displace something
in it.
