# ESS arrival position and time in the payload

NO behaviour change — a second payload roll, same shape as v28. Each
pilot's ESS arrival position and ESS time are now carried on
PilotScore, so the report card can substitute the §11.4 arrival
formula instead of asserting its output. The scorer computed the
position all along (essPositionMap) and discarded it, which left
arrival as the one component whose arithmetic could not be shown —
and, more importantly, left unsaid that the order is by wall-clock
time at ESS rather than by speed.
