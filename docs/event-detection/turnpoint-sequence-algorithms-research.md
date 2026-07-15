---
source: Claude Chat https://claude.ai/share/fa698b35-1034-4818-bd72-dcb2dbc9c3c0
---

# Hang Gliding & Paragliding Task Scoring: Turnpoint Sequence Algorithms

## How Turnpoint Sequence Resolution Works

The authoritative specification is **CIVL GAP** (FAI Sporting Code Section 7F), which governs scoring for both hang gliding and paragliding. The primary scoring software implementations are **FS** (the FAI's official tool) and **AirScore** (an open-source Python/Flask alternative used by FAI).

### The Core Algorithm

Scoring software doesn't track pilots in real time. It works *post-hoc* from IGC tracklog files. The fundamental process is:

1. **Collect all cylinder crossings.** The software scans the entire tracklog and records every instance where the pilot crossed any turnpoint cylinder boundary (in either direction). Each crossing gets a timestamp.

2. **Find a valid path through the crossings.** The software searches for a temporally ordered sequence of crossings — one per task turnpoint — where each crossing time is after the previous one. This is essentially a path-finding problem through a set of candidate crossings.

3. **Apply special rules for SSS (Start of Speed Section).** For SSS, the algorithm selects the *last* valid crossing before the pilot continues onward. For all other turnpoints, it selects the *earliest* valid crossing after the previous turnpoint was reached.

The key rule from Section 7F (2024 edition):

> *"Race start is defined as the crossing of the start control zone for the **last time** before continuing to fly through the remainder of the task."*

And for subsequent turnpoints:

> *"The reaching time for any turnpoint after SSS is that turnpoint's **first crossing time** after the previous turnpoint's reaching time."*

---

## Re-flies: Pilots Re-entering the Start Circle

This is a well-documented edge case and was the subject of **FS ticket #286** ("Detect re-start after taking first turnpoint"), which reveals how the algorithm actually handles it.

### The Scenario

A pilot crosses the start (SSS), flies to the first turnpoint, tags it, then — due to poor conditions, a bad line, or tactical reasons — flies back through the start circle and effectively "re-starts" the task.

### How FS Handles It (Historical Behavior)

FS's original `FindPathThroughCrossings` algorithm worked like this:

- For all turnpoints **except SSS**: find the **earliest** crossing that creates a valid temporal path.
- For **SSS**: find the **last** crossing.

The critical limitation was: **FS would not find a re-start after a valid crossing already existed for the first subsequent turnpoint.** If there was already a valid path through all turnpoints using the first set of crossings, the later path through a re-start was never considered.

### The Fix (For Multiple Start Gates / Elapsed Time)

FS ticket #286 proposed an iterative approach:

1. Run `FindPathThroughCrossings` to find the first valid path.
2. If the path reaches all turnpoints (pilot made goal):
   - Remove the SSS crossing used in that path.
   - Re-run `FindPathThroughCrossings`.
   - Repeat until no complete path is found.
   - **Use the last complete path found** — this gives the pilot the latest valid start, which is the most favorable.

### Single Start Gate vs. Multiple Gates / Elapsed Time

The behavior differs by task type:

| Task Type | Turnpoint Selection | SSS Selection |
|-----------|-------------------|---------------|
| Race, 1 start gate | **First** crossings | **Last** crossing |
| Race, multiple gates | **Last** crossings | **Last** crossing |
| Elapsed time | **Last** crossings (except ESS: first) | **Last** crossing |

For single-gate races, the algorithm takes the *first* valid crossing for each TP. This means a re-fly is essentially invisible — the earlier crossing stands, and the re-start is ignored. This can disadvantage pilots who re-start because their start time remains the original (later) SSS crossing, but they get the crossing times from their first pass through the turnpoints.

For elapsed time and multi-gate races, using the *last* crossings means a re-fly naturally resolves: the later re-start crossing replaces the original, and the later turnpoint crossings from the second attempt are used.

### Implication

**For single-gate races, a pilot who re-starts after tagging TP1 may get a suboptimal score.** The software might pair their late re-start SSS time with the early TP1 crossing from the first attempt, which doesn't reflect reality. This was a known limitation in FS.

---

## Start Circle That Is Also a Later Turnpoint

This is your `ELLIOT → KANGCK → ELLIOT → CORRY` scenario, where the SSS waypoint appears again as a regular turnpoint later in the task sequence.

### The Problem

The same physical cylinder generates crossings for *two different roles*:
- **Position 0 (SSS):** The start — algorithm wants the *last* crossing before continuing.
- **Position 2 (TP2):** A regular turnpoint — algorithm wants the *first* crossing after TP1 was reached.

Since both use the same geographic cylinder, every crossing of that cylinder is a candidate for *both* positions. A naive implementation would see the pilot's SSS crossing and might also count it as the TP2 crossing, which would be wrong (the pilot hasn't been to KANGCK yet).

### How It Should Be Resolved

The temporal ordering constraint is what makes this work correctly:

1. The pilot crosses ELLIOT (SSS) at time T₁ — this is the start.
2. The pilot flies to KANGCK and crosses it at time T₂ (where T₂ > T₁).
3. The pilot flies back to ELLIOT and crosses it again at time T₃ (where T₃ > T₂).
4. The pilot flies to CORRY.

The algorithm should assign:
- SSS (ELLIOT): the crossing at T₁ (or the last crossing before T₂ if multiple)
- TP1 (KANGCK): crossing at T₂
- TP2 (ELLIOT): crossing at T₃ (the first ELLIOT crossing **after** T₂)
- Goal (CORRY): crossing after T₃

The key is that the TP2 crossing must have a timestamp *after* the TP1 reaching time. Since TP1 (KANGCK) was reached at T₂, the TP2 (ELLIOT) crossing must be at T₃ > T₂, which correctly excludes the SSS crossing at T₁.

### Potential Pitfalls

- **Implementation treats waypoints by name/ID rather than task position.** If the software de-duplicates crossings by waypoint name, it might not correctly distinguish the SSS role from the TP2 role. Crossings need to be tracked per *task position*, not per waypoint.
- **Cylinder overlap.** If the ELLIOT cylinder is large enough that the pilot is *inside* it when flying past to/from KANGCK, spurious crossings could be generated. The algorithm needs to ensure it picks the right one.
- **The SSS "last crossing" rule could conflict.** If the algorithm greedily takes the *last* ELLIOT crossing as the SSS time, it might accidentally consume the crossing that should have been TP2. The temporal path constraint should prevent this, but only if the algorithm correctly searches for a *globally valid* path rather than greedily assigning crossings to positions.

---

## A Later Turnpoint Inside (or Overlapping) the Start Circle

This is the scenario: `ELLIOT (SSS) → KANGCK → NCORGL`, where NCORGL is physically inside or partially overlapping the ELLIOT start cylinder. To tag NCORGL, the pilot must fly back into the start circle.

### Why This Is Distinct From a Re-fly

In a voluntary re-fly, the pilot chooses to re-enter the start circle to restart. Here, the pilot **must** re-enter the start circle as part of the normal task route. This is not a restart — the pilot has already tagged KANGCK (TP1) and is progressing through the task. But re-entering the ELLIOT cylinder generates new SSS crossings.

### The Start Time Corruption Problem

The SSS rule says to use the **last crossing** of the start cylinder before continuing through subsequent turnpoints. Here's the timeline:

1. T₁: Pilot crosses ELLIOT (SSS) outbound — **intended start**
2. T₂: Pilot crosses KANGCK (TP1)
3. T₃: Pilot crosses back into ELLIOT cylinder en route to NCORGL — **spurious SSS crossing**
4. T₄: Pilot tags NCORGL (TP2, inside ELLIOT cylinder)
5. T₅: Pilot crosses out of ELLIOT cylinder en route to goal — **another spurious SSS crossing**

A naive implementation applying the "last SSS crossing" rule might pick T₃ or T₅ as the start time instead of T₁. This would be catastrophically wrong — it would either:
- Give the pilot a much later start time (penalizing them unfairly on time), or
- If it picks a crossing *after* TP1 was reached, break the temporal ordering entirely (SSS time must be before TP1 time)

### How the Spec Handles It

The 2020 Section 7F spec contains two key protections:

**1. "Before all subsequent turnpoints" constraint (multi-gate / elapsed time):**

The spec defines SSS reaching time as:
> *"that turnpoint's last crossing time that is **before all the subsequent turnpoint's reaching times**"*

This means the SSS crossing must have a timestamp before TP1 (KANGCK) was reached. The crossings at T₃ and T₅ both occur *after* T₂ (when KANGCK was tagged), so they're excluded. Only the crossing at T₁ qualifies.

**2. Explicit re-start limitation:**

The spec also states:
> *"A restart is possible up to the point where the first turnpoint has been reached. Returning to the start **after reaching the first turnpoint has no effect on the scored start time**."*

This is a clear statement that crossings of the SSS cylinder that occur after TP1 has been reached are ignored for start time purposes.

**3. Single start gate races:**

For single-gate races, the reaching time is "the first crossing time after the start gate time, and after the reaching time of the previous turnpoint." Since SSS is the first element, this is the first valid crossing after the gate opens. Later crossings (T₃, T₅) don't replace it because the single-gate rule uses the *first* valid crossing for SSS.

### Where It Could Still Go Wrong

Even with these protections, there are implementation risks:

- **The `FindPathThroughCrossings` algorithm may not correctly exclude late SSS crossings.** If it greedily assigns "last crossing" to SSS without first establishing the full temporal chain, it could pick T₃ or T₅ and then fail to find a valid path — potentially scoring the pilot as not having started at all, rather than falling back to T₁.

- **If SSS and NCORGL cylinders overlap significantly**, the pilot might tag NCORGL *while still outside the ELLIOT cylinder* (if NCORGL is only partially inside). In that case, no spurious SSS crossings are generated and the problem doesn't arise. But if NCORGL is entirely inside ELLIOT, the pilot *must* cross the ELLIOT boundary to reach it.

- **Crossing direction ambiguity.** The pilot crosses into ELLIOT at T₃ and out at T₅. Pre-2020, when enter/exit mattered, the scoring might only count one of these as a valid SSS crossing depending on the configured direction. Post-2020, both crossings are valid (direction is irrelevant), which actually *increases* the risk of start time corruption if the implementation doesn't properly apply the temporal constraints.

- **Flight instruments may behave incorrectly during the task.** An instrument might see the pilot re-entering the SSS cylinder and think the pilot is restarting, potentially resetting navigation or showing incorrect information to the pilot in flight.

### Task Setting Implications

The 2017 GAP spec explicitly acknowledges that the relationship between SSS and the first turnpoint matters:

> *"For start cylinders (SSS), 'enter' only makes sense if the following turnpoint cylinder lies within the SSS cylinder. Likewise, an 'exit' only makes sense if the first turnpoint lies outside of the SSS cylinder."*

This only discusses the *first* turnpoint relative to SSS. It says nothing about *later* turnpoints being inside the SSS cylinder. Task setters who place a later turnpoint inside the start circle are creating a scenario that the specification doesn't specifically anticipate, relying entirely on the temporal ordering constraints to keep scoring correct.

**Recommendation for task setters:** Avoid placing turnpoints inside or overlapping with the start cylinder unless it's the immediately following turnpoint (which is the expected enter-SSS pattern). If it must be done, verify with the scoring software beforehand that it handles the crossing disambiguation correctly.

---

## Additional Concerns and Edge Cases

### 1. Enter vs. Exit Direction Removed (2020+)

Modern CIVL GAP (from the 2020 edition onward) **removed the enter/exit distinction** for turnpoints. A turnpoint is considered reached when the pilot crosses the cylinder boundary in *any* direction. The specification states:

> *"The designation of 'enter' or 'exit' cylinder has been removed, to reduce a potential source of confusion and task setting errors."*

Task setters may still *indicate* a direction for route clarity, but pilots aren't bound to it. This simplifies scoring but means the algorithm must handle crossings in both directions as valid.

**Concern:** This makes spurious crossings more likely. A pilot thermalling near a cylinder boundary might generate many crossings, and the algorithm must pick the correct one.

### 2. Overlapping Cylinders

Modern competition tasks often use very large cylinders (e.g., 50 km radius). When two turnpoints' cylinders overlap, a pilot can be "inside" both simultaneously. Crossing one might inadvertently register as a crossing of the other.

The scoring software must ensure that cylinder crossings are evaluated independently per task position. A single tracklog fix (GPS point) might be inside TP2's cylinder and outside TP3's cylinder at the same time — this is fine and expected.

### 3. Tolerance Band and Near-Misses

CIVL GAP applies a tolerance band to cylinder crossings (FAI S7F §8.1), a percentage plus a **5 m absolute minimum**:
- **Cat 1 events:** 0.1% of radius
- **Cat 2 events:** up to 0.5% of radius
- `outerRadius = max(radius × (1 + tol), radius + 5 m)`
- `innerRadius = min(radius × (1 − tol), radius − 5 m)`

The band extends both outward and inward. Entry cylinders (turnpoints, ESS, goal) are credited at the **outer** edge; a start you EXIT is credited at the **inner** edge, so a pilot leaving the start is credited a touch early rather than a touch late (§8.2/§8.3). The 5 m minimum matters for small cylinders — 0.5% of a 400 m turnpoint is only 2 m.

A crossing is valid if:
- A single tracklog point falls inside the tolerance band, OR
- Two consecutive tracklog points lie on opposite sides of the cylinder boundary

This means a pilot who just barely touches the tolerance band is considered to have reached the turnpoint. The scoring algorithm must apply tolerance *before* evaluating crossings. GlideComp implements this in `detectCylinderCrossings` (`web/engine/src/turnpoint-sequence.ts`) and flags such near-misses as `toleranceCredited` so the per-pilot score explanation can call them out.

### 4. GPS Recording Interval

Tracklog points are typically recorded every 1–5 seconds. A pilot flying at 60 km/h covers ~17 m/s. With a 5-second interval, that's 83 meters between fixes. For small cylinders (400m radius), a pilot might fly through the cylinder entirely between two fixes. The tolerance band and crossing-detection logic (interpolating between consecutive points) are designed to handle this, but it's a source of scoring disputes.

### 5. ESS (End of Speed Section) — No Re-tries After Crossing

The CIVL GAP spec notes that for **ESS**, the *first* crossing is always used (even in elapsed time/multi-gate tasks). This means once a pilot crosses ESS, they cannot go back and try for a faster time. This asymmetry (last for SSS, first for ESS) is intentional but creates a subtle algorithm requirement.

### 6. Task Deadline Interactions

All crossings must occur before the **task deadline**. A pilot who tags turnpoints after the deadline gets no credit. The algorithm must filter crossings by the deadline *before* searching for valid paths. A re-fly that occurs after the deadline would be ignored entirely.

> **Implemented** (issue #260): `resolveTurnpointSequence` resolves the xctsk `goal.deadline` onto the flight's day, excludes later crossings from sequence resolution (they stay in the raw crossing list for transparency), and clips best-progress distance at the deadline (S7F §8.3.c, §8.6.1, §11.1). Start crossings before the launch window opens (`takeoff.timeOpen`) likewise cannot validate a start. A deadline at/before the first start gate is treated as a mis-set task and ignored.

### 7. Early Start ("Jump the Gun")

If a pilot's last SSS crossing (in the start direction) occurred *before* the start gate time:

- **Paragliding:** The pilot is only scored for the distance from launch to SSS — effectively zeroed out for the task.
- **Hang gliding:** A penalty is applied (1 point per X seconds early, up to Y seconds max). Beyond Y seconds, scored for minimum distance only.

For the re-fly scenario, this interacts poorly: if the pilot's *original* start was valid but their *re-start* is also valid, the algorithm should use whichever gives the best result. But if the re-start happens to be before a later start gate, it could trigger a jump-the-gun penalty when the original start was clean.

### 8. Stopped Tasks

When a task is stopped (e.g., due to dangerous weather), distance is calculated based on position at the stop time. Turnpoint crossings after the stop time are ignored. If a pilot was mid-re-fly when the task was stopped, they'd be scored based on the furthest distance achieved at the stop time, which might be from their first attempt.

### 9. Distance Calculation with Shared Waypoints

Task distance is calculated as the shortest path from start to goal touching all cylinder boundaries. When a waypoint appears twice (like ELLIOT in your example), the shortest-path algorithm must treat them as separate nodes. The optimal point on the ELLIOT cylinder for SSS exit may be different from the optimal point for TP2 entry, since the incoming/outgoing legs are different.

### 10. Leading Points and Shared Waypoints

Leading points (which reward pilots who fly at the front of the pack) are calculated using distance remaining to goal over time. When a pilot flies *back* toward the start for a re-fly, their distance-to-goal increases. This hurts their leading coefficient. The leading points algorithm doesn't care about re-flies — it simply tracks position over time.

### 11. Flight Instrument Navigation vs. Scoring Software

Flight instruments (XCTrack, XCSoar, LK8000, Flymasters) navigate pilots through the task in real time. These instruments typically advance to the next turnpoint once the current one is detected as "reached." If the start waypoint appears later as a turnpoint, the instrument needs to know not to prematurely advance when the pilot is near the SSS at the start. XCTrack notes that it "does not distinguish between ENTER and EXIT cylinders" except for the start — suggesting this is a known implementation challenge.

---

## Summary of Key Algorithm Requirements

For any scoring implementation handling these edge cases correctly:

1. **Track crossings per task position, not per waypoint.** The same waypoint at different positions in the task must be treated as independent.
2. **Use temporal ordering as the primary constraint.** Each turnpoint's crossing must be strictly after the previous one.
3. **SSS uses the *last* valid crossing; other TPs use the *first*.** (With variations by task type.)
4. **Re-fly detection requires iterative path-finding** for multi-gate and elapsed-time tasks. For single-gate races, the limitation is accepted.
5. **Apply tolerance before evaluating crossings.** A near-miss within tolerance is a valid crossing.
6. **Filter by task deadline and start gate times** before searching for paths.
7. **The shortest-path distance algorithm must handle repeated waypoints** as separate nodes with potentially different optimal touch points.

---

## Algorithm Design: Recursive SSS Backtracking

### The Approach

Start with the last SSS crossing. Try to build a valid temporal path forward through all remaining turnpoints to goal. If that fails, step back to the previous SSS crossing and try again. Continue until either a valid path is found or all SSS crossings are exhausted.

For pilots who make goal, this is clean: the "valid path" is one that reaches every turnpoint in order and terminates at goal.

### The Non-Goal Problem

When a pilot doesn't make goal, there's no binary "reached goal / didn't reach goal" test to validate the path. The algorithm needs a different definition of "best valid flight."

### What the Spec Says

The distance formula for non-goal pilots is:

> *Flown distance = Task distance − shortest distance the pilot still had to fly*

The process is:
1. Determine which turnpoints the pilot reached (considering all timing restrictions).
2. After the last turnpoint reached, scan every remaining tracklog point and calculate the shortest distance to goal from each.
3. The pilot's flown distance uses the best (minimum remaining distance) tracklog point.

So flown distance is a function of **two things**: how many turnpoints were reached, and how far past the last reached turnpoint the pilot got before landing.

### "Best Valid Flight" for Non-Goal Pilots

This means "most turnpoints reached" is **necessary but not sufficient** as a definition. Consider:

**Scenario A — More TPs, less distance:**
- SSS crossing at T₁ → reaches TP1, TP2, TP3 → lands 2 km past TP3
- Flown distance: task distance up to TP3 boundary + 2 km

**Scenario B — Fewer TPs, more distance (from different SSS):**
- SSS crossing at T₅ → reaches TP1, TP2 → lands 30 km past TP2 (almost at TP3)
- Flown distance: task distance up to TP2 boundary + 30 km

Scenario B could potentially yield a *higher* flown distance than Scenario A despite reaching fewer turnpoints. But this shouldn't matter, because the spec's distance calculation is explicitly tied to which turnpoints were reached first, and then best progress past the last one.

### Recommended Algorithm

For the recursive backtracking approach, the "best valid flight" for non-goal pilots should be determined by:

1. **Primary: Maximum turnpoints reached.** A path that reaches TP1, TP2, TP3 always beats one that reaches TP1, TP2 — regardless of distance.

2. **Secondary: Maximum flown distance.** Among paths that reach the same number of turnpoints, pick the one that yields the highest flown distance (i.e., the pilot got furthest past the last TP reached).

3. **Tertiary (for time scoring): Latest valid SSS crossing.** Among paths with equal turnpoints reached and equal distance, prefer the latest SSS crossing. This gives the pilot the best possible start time, which matters if they also reached ESS (pilots who reach ESS but not goal are handled differently in PG vs HG — in HG they still get time points).

In practice, for single-gate races, the primary criterion (most TPs reached) almost always produces a unique answer, and the recursive backtracking from the last SSS rarely changes anything for non-goal pilots. The complexity matters most for elapsed-time and multi-gate races where the pilot genuinely has multiple valid start options.

### The Degenerate Case: No Valid Path From Any SSS

If no SSS crossing produces even a single subsequent TP reached, the pilot is scored for the distance from launch to the SSS cylinder boundary (or minimum distance, whichever is greater). This covers pilots who launched but never made a valid start.

### Implementation Note

The algorithm doesn't actually need full recursion in the computer science sense. It's iterative: try the last SSS, evaluate forward greedily (first valid crossing for each subsequent TP), record the result (TPs reached + distance), then try the second-to-last SSS, and so on. Keep the best result. The "recursive" intuition is correct — you're working backwards through SSS crossings — but the forward path evaluation from each SSS is a simple linear scan.

For the edge cases discussed earlier (turnpoint inside start circle, start circle as a later TP), this approach naturally handles them: the spurious SSS crossings generated by re-entering the start circle will fail to produce paths with more TPs reached than the original start, so the algorithm will settle on the correct (earlier) SSS crossing.

---

## Key References

- **FAI Sporting Code Section 7F** (CIVL GAP, 2024 edition) — the authoritative specification
- **FS Ticket #286** — "Detect re-start after taking first turnpoint" (documents the `FindPathThroughCrossings` algorithm)
- **FAI-CIVL/FAI-Airscore** (GitHub) — open-source Python scoring implementation
- **GlideAngle/CIVL-GAP** (GitHub) — LaTeX reproduction of the GAP scoring docs with issue tracker discussing edge cases
- **XCTrack Competition Tutorial** — documents how flight instruments handle these scenarios
- **Oz Report archives** — Joerg Ewald's explanations of the enter/exit direction removal and crossing detection