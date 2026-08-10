# Paragliding leading-weight formula generation

Paragliding leading-weight formula generation (issue #257). A new
`leadingWeightFormula` param ('gap2020' | 's7f2024') and
`leadingTimeRatio` (0–0.5, default 0.26) let a PG comp score its
leading↔time weight split under either the GAP2020/AirScore formula or
the FAI S7F 2024 §10 LeadingTimeRatio formula (leading =
LeadingTimeRatio × (1 − DW) at goal, and the whole non-distance weight
when nobody makes goal). The default is date-based (resolveCompGapParams):
PG comps created on/after 2026-07-15 default to 's7f2024', earlier comps
to 'gap2020' — so no pre-existing comp's scores move. Hang-gliding
weights are untouched. Bump rolls caches so new-default comps recompute.
