# Thermal Detection Algorithm

Specification for the thermal detection logic in `web/analysis/src/event-detector.ts`.

## Overview

The algorithm scans a flight track (array of IGC fixes) and identifies segments where the pilot was thermalling — circling in rising air to gain altitude. It uses a sliding-window state machine that transitions between "not in thermal" and "in thermal" states based on average climb rate.

Detected thermals drive several downstream features:
- **Thermal entry/exit events** shown in the Events tab
- **Climbs tab** ranking thermals by altitude gain
- **Glide segments** defined as the gaps between thermals
- **Sinks tab** (glides with poor L/D), which also depends on thermal boundaries
- **Segment highlighting** on the map when a thermal or glide is selected

## Algorithm

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `windowSize` | 10 fixes | Smoothing window for climb rate. Large enough to filter GPS noise, small enough to detect short thermals. |
| `minClimbRate` | 0.5 m/s | Below this average, the pilot is not usefully climbing. Standard threshold in XC analysis. |
| `minDuration` | 20 seconds | Filters out brief updrafts and noise. A real thermal turn takes ~20-30s. |
| `exitThreshold` | 3 windows | Consecutive below-threshold windows required before declaring an exit. Provides hysteresis. |
| `minGapDuration` | 20 seconds | Minimum time between consecutive thermals. Prevents the same thermal from being split by brief turbulence. |

### State Machine

The algorithm iterates through fixes starting at index `windowSize` and maintains two states:

```
                    avgClimb > minClimbRate
                    (+ gap/overlap checks)
    ┌──────────┐  ──────────────────────────►  ┌────────────┐
    │  NOT IN  │                               │    IN      │
    │ THERMAL  │  ◄────────────────────────────│  THERMAL   │
    └──────────┘   exitCounter >= exitThreshold └────────────┘
                                                    │    ▲
                                                    │    │
                                           avgClimb │    │ avgClimb
                                           ≤ thresh │    │ > thresh
                                           (count)  │    │ (reset)
                                                    ▼    │
                                                ┌────────────┐
                                                │  COUNTING  │
                                                │   EXIT     │
                                                └────────────┘
```

### Sliding Window

At each index `i`, the average climb rate is computed over the preceding `windowSize` fixes:

```
avgClimb = (altitude[i] - altitude[i - windowSize]) / (time[i] - time[i - windowSize])
```

The inner loop sums pairwise altitude differences, but this telescopes to a simple start-to-end calculation. The pairwise approach accumulates time correctly when fix intervals are irregular.

### Entry Detection

When `avgClimb > minClimbRate` and we're not in a thermal:

1. The potential thermal start is set to `i - windowSize` (the left edge of the window that first showed good climb).
2. Two overlap guards are checked:
   - The start must be after the previous thermal's end index.
   - At least `minGapDuration` seconds must have elapsed since the previous thermal ended.
3. If both pass, we enter the "in thermal" state.

**Why `i - windowSize`?** The window represents the average climb from `i - windowSize` to `i`. Setting the start at the left edge captures the full segment where climbing was occurring, not just where we detected it.

### Exit Detection (Hysteresis)

When inside a thermal and `avgClimb ≤ minClimbRate`:

1. Increment `exitCounter`.
2. If `exitCounter < exitThreshold`: stay in thermal (the dip might be transient).
3. If `exitCounter >= exitThreshold`: confirm exit.

When `avgClimb > minClimbRate` while the exit counter is active, reset `exitCounter` to 0. This means brief dips (1-2 windows) in an otherwise strong thermal are tolerated.

**Why hysteresis?** Real thermals are turbulent. A pilot circling in a thermal will experience momentary drops in climb rate due to wind shear, core positioning, and GPS noise. Without hysteresis, a single rough turn could split one thermal into two.

### Thermal End Point: `thermalEnd = i - exitThreshold`

When the exit triggers at index `i`, the exit counter has been incrementing for exactly `exitThreshold` consecutive iterations. Tracing backwards:

| Iteration | `exitCounter` | `avgClimb` |
|-----------|--------------|------------|
| `i - 2` | 1 | ≤ threshold (first bad window) |
| `i - 1` | 2 | ≤ threshold |
| `i` | 3 | ≤ threshold (triggers exit) |
| `i - 3` | was 0 | > threshold (last good window) |

So `i - exitThreshold` = `i - 3` is the **last index where the sliding window average was still above the climb threshold**. This is the correct thermal end point — it's the last fix where we can confidently say the pilot was still in the thermal.

**Why not `i - exitThreshold + 1`?** That would be `i - 2`, the first index where the window average was already below threshold. Including it would add a fix where the pilot was no longer climbing well. The thermal's altitude gain and average climb rate would be diluted by weak/no-climb data.

**Sliding window lag:** The window average at any index reflects climb over the preceding `windowSize` fixes. This means the detected boundaries lag slightly behind the true thermal entry/exit. This lag is symmetric — it affects both entry and exit equally — so it doesn't bias the thermal's statistics.

### Duration Filter

After determining `thermalStart` and `thermalEnd`, the thermal is only recorded if its duration exceeds `minDuration` (20 seconds). This filters out brief updrafts that satisfy the climb threshold but aren't real thermals.

### End-of-Flight Handling

If the pilot is still in a thermal when the track ends (e.g., landing in lift), the thermal is closed at the last fix. The same duration filter applies.

### Thermal Statistics

For each accepted thermal, the algorithm computes:

| Statistic | Calculation |
|-----------|-------------|
| `startIndex` / `endIndex` | Fix indices defining the segment |
| `startAltitude` / `endAltitude` | GNSS altitude at boundary fixes |
| `avgClimbRate` | `(endAltitude - startAltitude) / duration` |
| `duration` | Time from start to end fix (seconds) |
| `location` | Centroid: mean lat/lon of all fixes in the segment |

## Downstream: Glide Detection

Glides are defined as the segments **between** thermals. See `glide-detection-spec.md` (in this directory) for the full algorithm, including sink classification, map visualization, and known limitations.

Thermal boundaries directly determine glide boundaries. If a thermal ends too early, the adjacent glide absorbs climbing flight. If it ends too late, the glide loses distance.

## Known Limitations

### Climbing Glides

The algorithm uses climb rate as its sole criterion. A pilot flying straight in lifting air (climbing without circling) will be detected as thermalling if their climb rate exceeds 0.5 m/s. The original spec comment mentions "relatively circular path" as a criterion, but this is **not currently implemented**.

This causes two visible issues:
- Straight climbing segments are labelled as thermals.
- Segments with weak lift (climbing below 0.5 m/s on glide) are neither thermal nor glide — they become gaps in the event list and are unselectable on the map.

See TODO.md for the tracked bug.

### Parameter Sensitivity

The fixed thresholds work well for typical XC flying conditions but may not suit all situations:

- **Weak thermals** (alpine early morning, coastal): Thermals below 0.5 m/s average will be missed. A pilot circling at 0.3 m/s won't register.
- **Strong conditions** (flatland summer): Many short thermals may merge if the gap between them is less than 20 seconds.
- **Fix rate variation**: The `windowSize` of 10 fixes assumes roughly 1 fix/second. IGC files with lower fix rates (e.g., 1 fix every 5 seconds) will have a much longer averaging window, potentially missing short thermals.

### Altitude vs. Climb Rate

The thermal end point is determined by when the window average drops, not by where the pilot reached peak altitude. In some cases the pilot may reach their highest point a few fixes after the window average drops below threshold (due to window lag). The thermal's `endAltitude` will be slightly below the true thermal top.
