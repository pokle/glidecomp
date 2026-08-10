# Parsing hardening

Parsing hardening (2026-07-12 review §2 Parsing). (a) B records are
field-validated before parsing — a corrupted record previously fed NaN
coordinates / an Invalid Date into the fixes array, poisoning distance
and climb math. (b) xctsk v1 turnpoints with an explicit radius of 0
keep it instead of being coerced to 400 m (radius is a scoring input;
v2 and the encoder already preserved 0). (c) HP/HO H-records are
recognized (IGC source char F|O|P), so pilot names recorded as
HPPLT/HOPLT are no longer dropped. (d) fuzzy waypoint-name containment
requires a 3+ char DB name — an empty or 1-2 char name matched almost
any query and substituted the wrong radius/altitude into IGC-declared
tasks.
