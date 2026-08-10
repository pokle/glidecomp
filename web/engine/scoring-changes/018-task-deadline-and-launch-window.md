# Task deadline and launch window enforcement

Task deadline + launch window enforcement (issue #260, S7F §8.3.c,
§8.6.1, §11.1). The xctsk goal deadline is now enforced: boundary
crossings after it are excluded from sequence resolution (so a
turnpoint/ESS/goal tagged too late no longer counts, and the goal
ratio only counts pre-deadline goals per §10), and a landed-out
pilot's best distance is measured only up to the deadline. Start
crossings before the launch window opens (takeoff.timeOpen) can no
longer validate a start — a pre-window crossing proves the pilot was
airborne before launching was allowed. Mis-set tasks are guarded: a
deadline at/before the first start gate, or a window open at/after
the deadline or after the first gate, is treated as unset. The result
carries deadline/launchWindow transparency fields and the score
explanation narrates the cutoff and each ignored crossing.
