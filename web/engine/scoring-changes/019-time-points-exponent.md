# Sport-correct leading/time-points pairing

Sport-correct leading/time-points pairing (issue #258). The
time-points exponent (S7F §11.2) is now an independent GAPParameters
knob (timePointsExponent) instead of being implied by the
leading-coefficient variant, and the per-category defaults adopt the
2024-spec pairing: HG → classic squared-distance LC + 5/6 exponent,
PG → weighted-area LC + 5/6 exponent (previously both categories
defaulted to the weighted LC, and 'classic' forced a 2/3 exponent).
An HG comp with no saved formula therefore switches from the weighted
LC to the classic LC (both at 5/6); comps that saved an explicit
leadingFormula keep the exponent it used to imply (classic → 2/3,
weighted → 5/6), so their scores are unchanged. The bump invalidates
cached scores for the null-/default-formula comps whose LC variant
changed.
