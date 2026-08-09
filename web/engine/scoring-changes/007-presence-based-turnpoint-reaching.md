# Presence-based turnpoint reaching

Presence-based turnpoint reaching (S7F §8 / FS semantics) — a pilot who
is already inside a cylinder when the previous turnpoint is reached is
credited at that same moment ('already_inside'), instead of requiring a
boundary crossing at or after it. Fixes a turnpoint nested inside a
larger following cylinder (e.g. a big ESS/goal ring around the final
TP): a finisher who tagged the nested TP from inside and never exited
was scored landed-out, and an exit/re-entry after the nested TP was
credited late, inflating the speed-section time.
