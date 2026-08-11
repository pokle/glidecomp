# PG leading-weight generation naming

No behaviour change — documentation only. Comparing the engine against
the FAI S7F PDFs and the AirScore source showed the PG leading-weight
mode stored as 'gap2020' is really the GAP2016/2018 formula (the true
S7F 2020–2022 generation uses PWC-derived weights GlideComp doesn't
implement); the gap-params/gap-formulas doc comments now say so. The
comments touch hashed scoring sources, so the fingerprint guard
requires a bump. The cache roll is harmless (scores recompute
identically).
