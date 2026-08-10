# Ding et al. (2018) vs the GlideComp task optimiser — an audit

A companion to the annotated transcription
([ding-2018-touring-n-circles.md](ding-2018-touring-n-circles.md)). The
paper matters because FAI S7F (2026 Edition, §7.1.3) defines its
route-optimisation algorithm — "PathFinder" — by reference to it, normative
for Category 1 task and flown-distance calculation from 1 May 2026. This
document compares the paper's algorithm with the engine's implementation in
[`web/engine/src/task-optimizer.ts`](../../../web/engine/src/task-optimizer.ts)
(see also [docs/optimized-task-line-spec.md](../../optimized-task-line-spec.md)
and
[docs/research/task-optimization-comparison.md](../../research/task-optimization-comparison.md),
which compares the engine with AirScore and the GAP spec rather than with
this paper).

## Verdict

The engine implements the same algorithm *family* as the paper — block
coordinate descent over per-circle "partial shortest path" subproblems,
iterated until the total length stops changing — and it handles
intersecting circles correctly, which is the paper's headline contribution.
It is not, however, a transcription of PathFinder. There are five
substantive differences:

| # | Aspect | Ding et al. (2018) | GlideComp engine |
|---|---|---|---|
| 1 | Sweep schedule | Odd/even alternation (Jacobi within each half-sweep) | Forward Gauss–Seidel pass |
| 2 | Per-circle solver | Reflection/crossing case split; closed-form PCP (8 candidate angles) | Golden-section search over θ; one explicit crossing shortcut |
| 3 | Crossed-cylinder tie-break | First intersection of the chord with the circle | Boundary point nearest the chord (deliberate; matches AirScore) |
| 4 | Convergence | ε = 10⁻¹⁰, no iteration cap | 1 m (Annex A), keep-best adoption, cap at n × 10 passes |
| 5 | Geometry | Euclidean plane | WGS84 ellipsoid (Andoyer–Lambert + Vincenty direct) |

On top of these, the engine layers FAI S7F placement rules the paper's
problem statement does not have (launch centre, ESS pin, goal/LINE
handling, remaining routes) — extensions, not contradictions.

## Where the structures line up

The paper's Algorithm 2 and the engine's `computeOptimizedTaskLine` share
the same skeleton: initialise a path touching each circle, repeatedly
re-solve each circle's touch point holding its neighbours fixed, stop when
successive path lengths agree within a tolerance. The paper's Step 1
("arbitrary initial points") corresponds to the engine's first pass, which
targets each next turnpoint's *centre* (`optimizePass` with
`previousPath = null`) — a warm start rather than an arbitrary one, but the
same role.

The two situations of the paper's Theorem 1 both arise and both get
handled:

- **Reflection** (both neighbours outside the circle and the path bounces
  off the boundary, or both inside and the path reaches out to it) —
  solved numerically by golden-section search in `findOptimalCirclePoint`.
- **Crossing** (the leg passes through the circle, or one neighbour is
  inside or on it) — the both-endpoints-outside case is detected
  explicitly by `chordCrossingPoint`; the endpoint-inside cases fall
  through to the numeric search, whose minimum *is* the segment–circle
  intersection there, so the right answer emerges without the case ever
  being named.

## Difference 1 — sweep schedule

Algorithm 2 alternates: fix the even circles, update all odd circles,
measure $L_j^o$; fix the odd circles, update all even circles, measure
$L_j^e$; compare the two half-pass lengths. The engine's `optimizePass` is
a single forward sweep that updates every circle in order, each one
immediately using the just-updated previous point while the next point
comes from the prior pass. That is Gauss–Seidel where the paper is
Jacobi-within-a-half-sweep.

Both converge to the same fixed point on real tasks. The practical
consequence is that the paper's monotonicity argument
($L_j^e \le L_j^o$, load-bearing in its Theorem 3 convergence proof) does
not transfer directly; the engine compensates with the keep-best adoption
rule and a `turnpoints × 10` iteration cap, neither of which the paper
needs or has. The alternation would also allow the half-sweep's updates to
run in parallel, which competition tasks (≤ ~10 circles) never need.

## Difference 2 — the per-circle solver

This is the biggest divergence. The paper's *GetoptPi* first *classifies*
the configuration: tangent lines from the outside neighbour divide the
plane into crossing region $C$ and reflection region $R$ (§3.2, Figure 6),
and the reflection case is then solved **in closed form** by PCP — the
Chou (2008) quartic whose eight candidate angles $\theta_1 \ldots \theta_8$
are enumerated and the shortest taken (Eq. 1).

The engine skips both the $R$/$C$ construction and the closed form, and
minimises the cost numerically over $\theta \in [0, 2\pi]$. Two honest
observations about that trade:

- **The closed form is intrinsically planar.** PCP is a Cartesian quartic;
  it has no analogue on the WGS84 ellipsoid, where the engine's costs are
  Andoyer–Lambert distances and points are placed with Vincenty direct. A
  faithful PCP port would require projecting to a plane (as AirScore does)
  and re-importing the projection error. The numeric search is the
  structurally honest choice for ellipsoidal geometry — the only planar
  computation in the file is the local east/north frame inside
  `chordCrossingPoint`, and that is placement-only.
- **PCP is a global per-circle minimum; golden section assumes
  unimodality.** Eq. 1 takes the minimum over all eight candidates
  precisely because the cost can have two local minima — the path can
  round the circle on either side (the LK8000 note quoted in
  [optimized-task-line-spec.md](../../optimized-task-line-spec.md) is
  about exactly this). The comment above `findOptimalCirclePoint` claims
  the cost is unimodal, which is not true in the worst case; the search
  also treats a periodic function as linear on $[0, 2\pi]$, so a
  minimiser near bearing 0 straddles the bracket ends. In practice the
  outer iteration, the chord shortcut and real task geometry make this
  invisible — `distance-corpus.test.ts` asserts parity with AirScore's
  published per-waypoint cumulatives across the 196-task archive — but on
  a worst-case basis this is the one place the engine is weaker than the
  paper, and the source comment overstates the guarantee.

## Difference 3 — the crossed-cylinder tie-break (deliberate)

When the leg passes straight through a cylinder, *GetoptPi* line 4 places
$p_i$ at "the first point of intersection of line $p_{i-1}p_{i+1}$ and
circle $O_i$" — a point *on the chord*, so the local length is exactly
$|p_{i-1}p_{i+1}|$. The engine instead places the tag at the boundary
point nearest the chord — the perpendicular foot from the centre projected
radially outward (`chordCrossingPoint`) — which is *not* on the chord and
costs centimetres more. This is documented and intentional: it matches
AirScore's published per-leg cumulatives, and the excess is far below the
1 m convergence tolerance.

Worth flagging for the 2026-edition audit, though: since S7F 2026 §7.1.3
makes this paper normative for Category 1 from 1 May 2026, this tie-break
is the one line where the engine knowingly does something different from
the referenced text. The distance effect is sub-metre, but the tag
*placement* differs visibly — the boundary point beside the chord versus
the entry intersection on it. If exact PathFinder parity is ever required,
this is the line to change.

## Difference 4 — convergence

The paper uses $\varepsilon = 10^{-10}$ (machine precision) with no
iteration cap, comparing the two half-pass lengths within one iteration.
The engine uses 1 m (the Annex A tolerance), compares successive full
passes, only adopts a pass that improves, and caps at
`turnpoints × 10` iterations. Same mechanism, different precision
philosophy: the paper wants the mathematical optimum; the engine wants the
scoring-spec answer, cheaply and safely.

## Difference 5 — plane vs ellipsoid

The paper's whole apparatus — the PCP quartic, the tangent-line $R$/$C$
division, "the first point of intersection of line and circle" — is
Euclidean. The engine works directly in geographic coordinates on the
WGS84 ellipsoid, with no projection step (unlike AirScore's transverse
Mercator plane). This is what forces Difference 2: on the ellipsoid there
is no closed-form PCP to port, so a numeric search per circle is the
natural substitute.

## The FAI placements layered on top

The paper's $s$ and $t$ are free fixed points and every circle is
searched. The engine pins several positions by S7F rule instead:

- **Launch** is the first turnpoint's **centre** regardless of radius
  (Annex A §2.2), except under `XCTask.firstTurnpointAtBoundary`.
- A **mid-route ESS** is pinned to its incoming leg (Annex A §3.2.4,
  `pinnedESSIndex`), deliberately kinking the path so the launch→ESS
  prefix equals the standalone §6.4.2 optimisation by construction.
- The **goal** takes the nearest-boundary-point rule, or the closest point
  on a LINE goal (`findOptimalGoalLinePoint`).
- `optimizeRemainingRoute` re-runs the whole algorithm anchored at an
  arbitrary pilot position for the §8.6.1 flown-distance measurement — a
  reuse the paper has no counterpart for.

None of this contradicts the paper; it is the competition-scoring problem
statement wrapped around the paper's geometric core.

## A caution about auditing against the paper's pseudocode

Audit against §3.1–§3.2's geometric analysis, **not** Algorithm 1's
pseudocode verbatim. Beyond the typo already flagged in the
transcription's appendix, the printed *GetoptPi* contradicts the paper's
own analysis in two places:

- Line 3 tests "if $p_{i-1}$ in the regions $C$" where it must mean
  $p_{i+1}$ — $p_{i-1}$ is the apex the tangent lines are drawn from and
  cannot be in $C$.
- Lines 7–9 appear inverted against Figure 7 and Theorem 1's case (b): as
  printed they apply PCP (reflection) when $p_{i-1}$ is inside and
  $p_{i+1}$ is outside, but §3.2 says that configuration admits *only* the
  crossing situation, and reflection only when both points are inside.

The engine's numeric fall-through produces the *correct* (§3.2) behaviour
in those configurations — one point in and one out finds the crossing
intersection, both in finds the reflection point — not the pseudocode's.

## Bottom line

The engine is a numerically robust, ellipsoid-native, FAI-rule-aware
reimplementation of the paper's iterative scheme rather than a port of
PathFinder's exact machinery. The two defensible gaps versus the paper are
the unimodality assumption in the per-circle search (worst-case only; the
source comment could be softened) and the crossing tie-break (deliberate,
AirScore-matching, but not what the S7F-2026-normative text says).
Everything else is either equivalent by a different mechanism or a domain
extension the paper does not cover.
