# defaultsFor() FAI-class doc comment

No behaviour change — documentation only. defaultsFor() gained a doc
comment recording the FAI-class mapping (PG = Class 3; HG = Classes
1/2/5 all score under the HG profile), which touches a hashed scoring
source, so the fingerprint guard requires a bump. The extra cache roll
is harmless (scores recompute identically).
