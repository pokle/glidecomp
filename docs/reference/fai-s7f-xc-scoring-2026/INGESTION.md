# How this reference was produced

`s7f-xc-scoring-2026.md` is a machine-optimised transcription of the FAI
Sporting Code **Section 7F — XC Scoring, 2026 Edition V1.0** (effective
1 May 2026; `Sporting Code S7 F - XC Scoring 2026_V1.0.pdf` from
fai.org's CIVL documents). It was ingested with the shared pipeline in
[`../extract_s7f.py`](../extract_s7f.py) following the process documented in
[`../fai-s7f-xc-scoring-2024/INGESTION.md`](../fai-s7f-xc-scoring-2024/INGESTION.md)
— that file remains the canonical description of the pipeline, the
transcription conventions and the future-edition workflow. Only what is
specific to this edition is recorded here.

## Why this edition sits beside 2024, not in place of it

Tasks are scored under the rules in force when they were flown, and GlideComp
scores historical competitions and AirScore imports. The 2024 transcription
stays authoritative for pre-2026 formulas (e.g. Launch Validity's 0.027
linear coefficient); this one is authoritative from 1 May 2026. The per-task
`gap_params` machinery is where an edition choice would surface in the
engine.

**Note:** FAI also published a 2025 edition that GlideComp never ingested.
Its changes are folded into this document's own change history (§2.1.1.14),
so nothing is lost — but there is no 2025 transcription directory, and one
would only be needed if a comp scored under 2025-specific rules had to be
explained in detail.

## Edition-specific notes

- **Red change-marking works in this edition** (unlike the 2024 file, which
  contained none despite §1.3 promising it). Every 2026 change is printed
  red; the pipeline extracts red spans per page (`red_changes` in the annot
  JSON — support added to `extract_s7f.py` during this ingestion). In the
  transcription: whole red blocks carry a
  `*(Red in source: changed in this edition.)*` marker line; short red
  phrases are wrapped `<ins>…</ins>`.
- **Discipline marking now pairs each coloured band with a margin icon**
  (hang-glider or paraglider silhouette), so the distinction survives
  grey-scale printing. The icons render as small images and pollute the
  figure-crop clustering — several `pNN-figK.png` crops are icon artefacts,
  skipped by the transcribers and listed in the appendix.
- The four formulas that were truncated in the 2024 PDF (LeadingFactor,
  StoppedTaskValidity, timePointsReduction, altitude-bonus bestDistance) are
  all complete in this edition; the 2024 transcription's `UNREADABLE` markers
  have their answers here.
- The space-less 2023-era pseudocode annex is gone, replaced by §7's
  algorithm definitions (projection, route optimisation, geodesics) with
  external references.

See the "Source-extraction notes" appendix at the bottom of
`s7f-xc-scoring-2026.md` for this edition's own defect list.
