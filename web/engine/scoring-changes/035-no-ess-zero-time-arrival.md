# Zero time and arrival points when nobody reaches ESS

NO pilot's points change — the S7F §10 "nobody reaches ESS" rule
(issue #583). On a hang-gliding task where numReachedESS is 0, the
spec's HG box sets AvailableTimePoints and AvailableArrivalPoints to
zero, and redistributes nothing: distance and leading keep their usual
weights and the remainder of the day is left unallocated. GlideComp
published the normal non-zero figures, so the scoreboard and the report
card advertised points nobody could win — time points require an ESS
crossing and the arrival position map is empty, so both components were
already zero for every pilot.
calculateWeights now takes the ESS count and returns zeroed time and
arrival fractions in that case; availablePoints follows, while
availablePoints.total stays 1000 × task validity (the day's worth), so
the components deliberately fall short of it by the unallocated
remainder. Every explanation that compares a pilot against "the day"
now names that remainder rather than presenting it as points they left
untaken.
Bumped because availablePoints and validity_inputs.weights are part of
the cached payload: without a roll the stale-first store would serve
the pre-change figures for settled comps indefinitely.
