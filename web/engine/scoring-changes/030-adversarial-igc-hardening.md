# Hardening against adversarial IGC files

NO score change on well-formed tracks — algorithmic hardening against
adversarial IGC files (#470 SEC-32, #471 SEC-33). The cross-channel
rolling residual median is now maintained incrementally by an exact
order-statistic structure (same window multiset → same two middle
values → identical float baseline), the never-airborne glide check
takes its window minimum from a monotone deque, and rateClean's
excursion return-scan stops at a non-forward timestamp. All three were
quadratic when a crafted file stamped tens of thousands of fixes into
one small time span — a per-upload CPU sink, since cleaning runs
inside parseIGC on every upload. Only tracks whose timestamps jump
backwards — already corrupt — can score differently, and only via the
rate path.
