# S7F 2026 phase 1 — parameter model and constants

FAI S7F 2026 edition, phase 1 — parameter model + constants
(docs/2026-08-09-s7f-2026-migration-plan.md). GlideComp now scores
every task under the 2026 edition; the pre-2026 formula variants are
deleted, not selectable. In this phase:

- Launch validity linear coefficient 0.027 → 0.028 (§10.1; the 2025
edition fixed a typo dating from ~2014). Every task's launch
validity moves by up to ~0.0005.

- Nominal Launch (96%) and Nominal Goal (30%) are fixed spec values,
no longer parameters (§10.1, §10.2). Comps that stored other values
(engine baseline nominalGoal 0.2 included) are now scored at the
fixed ones.

- The PG leading-weight generations ('gap2020' GAP2016/2018,
's7f2020' PWC, 's7f2024') are gone; §11 is the one formula for both
disciplines: LeadingWeight = (1 − DW) · LeadingTimeRatio, with the
whole non-distance weight to leading on a no-goal PG day. HG gains
LeadingTimeRatio as a settable task parameter (default 17.5%,
numerically identical to the old hard-wired (1 − DW)/8 · 1.4).

- LeadingTimeRatio range 0–26% (§11; was 0–50%).
- The 2/3 time-points exponent is gone; §12.2's 5/6 is the only curve.
- The LC variant (classic/weighted) is pinned per discipline
(§12.3.1), no longer a parameter.

- Best time (§9.4.1) is discipline-pinned: HG from all ESS pilots,
PG goal-validated — no longer keyed off essNotGoalFactor.

- Stopped tasks: score-back fixed at HG 15 min / PG 5 min (§13.4.1;
the PG scoreBackTime parameter and the HG gate-interval rule are
gone); PG has no minimum-duration requirement (§13.4.2); the PG
altitude-bonus glide ratio is 2.5 (§13.4.6; was 4.0).
Historical comps and AirScore imports are rescored under these rules
by design (owner decision, 2026-08-09): GlideComp keeps no
multi-edition support, and pre-2026 comps carry an "indicative
scores" notice in the UI instead.
