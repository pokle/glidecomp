# S7F 2026 phase 2 — the new PG leading coefficient

FAI S7F 2026 edition, phase 2 — the new PG leading coefficient
(§12.3.1, introduced by the 2025 edition). The weighted leadingArea
is now minToESS(tpᵢ) · taskTime(tpᵢ) · ∫ weight(x) dx over each
fix interval's done-fraction span, with the envelope integral in
exact closed form (leadWeightIntegral — the (1−10^{9p−9})⁵(1−10^{−3p})²
product expands to 18 integrable exponential terms). The missingArea
tail is minToESS(best) · maxTime · ∫ weight over the never-flown
remainder, replacing the old weightFalling(best)·maxTime·best term.
The previous implementation was the AirScore weightedarea form
(weight(p)·Δbest·time — a point-sampled Riemann sum with progress as
the amplitude); the 2026 form weights by REMAINING distance instead,
so every PG leading coefficient moves and land-out tails shift most.
HG (classic) is unchanged. The LeadingAggregate cache split
(weightedTimeSum/weightedDeltaSum) keeps the same rebasing shape, so
cached aggregates recompute under the new contribution formula via
the version bump alone.
