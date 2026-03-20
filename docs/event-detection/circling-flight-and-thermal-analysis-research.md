# Circle Detection & Thermal Analysis: Algorithm Research

Research into algorithms for detecting circling flight, extracting per-circle parameters, and estimating wind from thermal circles in GPS tracklogs (IGC files).

This document collects algorithms, thresholds, and references to inform implementation. The current thermal detector (`event-detector.ts`) uses climb rate only and does not detect circular flight — see `thermal-detection-spec.md` "Known Limitations".

---

## 1. Circling Detection Algorithms

### 1.1 Bearing Change Rate + State Machine (XCSoar)

Source: `XCSoar/src/Computer/CirclingComputer.cpp`

The most widely used real-time approach. Compute the rate of change of GPS track bearing — circling produces sustained high turning rates (~12-18 deg/s for a typical thermal circle at 25-30 km/h).

```
turn_rate_raw = (current_track - previous_track) / dt
clamp turn_rate_raw to [-50, +50] deg/s        // reject GPS spikes
turn_rate_smoothed = 0.3 * turn_rate_raw + 0.7 * turn_rate_smoothed_prev  // low-pass filter

turning = |turn_rate_smoothed| >= 4.0 deg/s     // MIN_TURN_RATE threshold
```

Four-state machine with hysteresis to prevent spurious mode switches:

```
CRUISE  ──[turning detected]──>  POSSIBLE_CLIMB
POSSIBLE_CLIMB  ──[turning sustained > T1 seconds]──>  CLIMB  (circling=true)
POSSIBLE_CLIMB  ──[turning stops]──>  CRUISE

CLIMB  ──[turning stops]──>  POSSIBLE_CRUISE
POSSIBLE_CRUISE  ──[no turning > T2 seconds]──>  CRUISE  (circling=false)
POSSIBLE_CRUISE  ──[turning resumes]──>  CLIMB
```

The two delay thresholds (T1 = cruise-to-circling, T2 = circling-to-cruise) provide hysteresis so brief turbulence or brief wings-level moments don't cause false transitions.

**Key parameters:**
- Minimum turn rate: **4 degrees/second**
- Low-pass filter coefficient: **0.3** (heavy smoothing)
- GPS fix rate requirement: better than 1 fix every 2 seconds

### 1.2 Bearing Change Rate + Viterbi HMM (igc_lib)

Source: `github.com/xiadz/igc_lib` (Python, by Marcin Osowski)

Uses a Hidden Markov Model with Viterbi decoding for globally optimal circling/straight classification. More robust than simple thresholding because it considers the full sequence of observations, not just local decisions.

```
Parameters:
  min_bearing_change_circling = 6.0 deg/s
  min_time_for_bearing_change = 5.0 s       // lookback window for bearing rate
  min_time_for_thermal = 60.0 s             // minimum thermal duration

Step 1: Compute bearing rate at each fix
  For each fix[i]:
    Find fix[j] where time[i] - time[j] >= 5.0s
    bearing_change_rate = normalize_angle(bearing[j] - bearing[i]) / (time[i] - time[j])
    // Using a wider time window (5s vs adjacent fixes) reduces GPS noise

Step 2: Generate observations
  For each fix:
    observation = "circling" if |bearing_change_rate| > 6.0 deg/s else "straight"

Step 3: Viterbi decode
  Hidden states: {straight, circling}
  Initial probabilities: P(straight) = 0.80, P(circling) = 0.20
  Transition matrix:
    P(straight -> straight) = 0.998
    P(straight -> circling) = 0.002
    P(circling -> circling) = 0.998
    P(circling -> straight) = 0.002
  Emission probabilities:
    P(observe "straight" | state=straight) = 0.942
    P(observe "circling" | state=circling) = 0.907

Step 4: Extract thermals
  Find contiguous segments where Viterbi state = "circling"
  Keep segments with duration >= min_time_for_thermal (60s)
```

The high self-transition probabilities (0.998) enforce temporal coherence — the algorithm strongly resists rapid switching between states.

### 1.3 Cumulative Heading Change (360-degree circle detection)

Used by XCSoar's wind estimator to detect individual complete circles within a thermal. Rather than classifying every fix as circling/straight, this accumulates bearing changes until they sum to a full revolution.

```
cumulative_bearing = 0
sample_count = 0
circle_start = current_fix

for each new GPS fix:
    delta_bearing = normalize(current_track - previous_track)
    cumulative_bearing += delta_bearing
    sample_count++

    if |cumulative_bearing| >= 360:
        if sample_count >= 8:   // minimum quality check
            process_complete_circle(fixes from circle_start to current)
        cumulative_bearing -= sign(cumulative_bearing) * 360
        circle_start = current_fix
        sample_count = 0
```

This is primarily useful for per-circle analysis (wind estimation, circle parameter extraction) rather than detecting the overall circling mode.

### 1.4 Netto Variometer + EKF (ArduSoar / ALOFT)

Source: ArduPilot ArduSoar controller, arxiv paper 1802.08215

Uses a netto variometer (total energy compensated to remove the aircraft's own sink) rather than GPS turning rate for thermal detection. Combined with an Extended Kalman Filter that models the thermal as a Gaussian updraft column.

Detection trigger: filtered netto vario exceeds `SOAR_VSPEED` threshold.

```
Netto vario calculation:
  e_net = e_total + v_z(v, bank_angle)     // remove aircraft polar sink
  e_filtered = 0.03 * e_net + 0.97 * e_filtered_prev  // heavy LP filter, tau~0.03

Thermal model (Gaussian updraft):
  w(x, y) = W_th * exp(-(x^2 + y^2) / R_th^2)

EKF State Vector:
  X = [W_th, R_th, x_thermal, y_thermal]   // 4 states
  - W_th = thermal strength (m/s)
  - R_th = thermal radius (m)
  - (x,y) = thermal center position relative to aircraft

Observation function:
  o = W_th * exp(-(x^2 + y^2) / R_th^2)

Thermal exit condition:
  Exit when: W_th * exp(-(x^2 + y^2) / R_th^2) - K_sink < SOAR_VSPEED
```

Most sophisticated for real-time use — simultaneously estimates the thermal's position, size, and strength. Primarily designed for autonomous UAVs but the thermal model could be valuable for post-processing analysis too.

---

## 2. Individual Circle Parameter Extraction

### 2.1 Circle Identification

Use cumulative heading change (Section 1.3). Each 360-degree accumulation marks one complete circle. Record start/end fix indices.

Turn direction: `sign(cumulative_bearing)` — positive = right turn, negative = left turn.

### 2.2 Circle Center and Radius: Least-Squares Circle Fit

For a set of GPS points `{(x_i, y_i)}` forming one circle (converted to local flat-earth meters relative to centroid), fit the best circle `(x_c, y_c, r)`.

Algebraic circle fit (Taubin/Kasa method):

```
// Convert lat/lon to local meters relative to centroid
x_mean = mean(x_i), y_mean = mean(y_i)
u_i = x_i - x_mean, v_i = y_i - y_mean

// Build moment matrices
Suu = sum(u_i^2), Svv = sum(v_i^2)
Suv = sum(u_i * v_i)
Suuu = sum(u_i^3), Svvv = sum(v_i^3)
Suvv = sum(u_i * v_i^2), Svuu = sum(v_i * u_i^2)

// Solve 2x2 linear system
denom = Suu * Svv - Suv^2
uc = (Svv * (Suuu + Suvv) - Suv * (Svvv + Svuu)) / (2 * denom)
vc = (Suu * (Svvv + Svuu) - Suv * (Suuu + Suvv)) / (2 * denom)

// Results
x_c = uc + x_mean
y_c = vc + y_mean
radius = sqrt(uc^2 + vc^2 + (Suu + Svv) / n)
```

Typical circle radii:
- Paragliders: **75-200m**
- Hang gliders: **100-300m**

### 2.3 Climb Rate Per Circle

```
climb_rate = (altitude_end - altitude_start) / (time_end - time_start)
```

### 2.4 Circle Quality (percentage of circle in lift)

```
for each fix in circle:
    instantaneous_vario = (alt[i+1] - alt[i]) / (t[i+1] - t[i])
    lifting = (instantaneous_vario > 0)

quality = count(lifting) / total_fixes   // 0.0 to 1.0
```

Interpretation:
- **> 80%**: Well-centered thermal, pilot is in the core
- **50-80%**: Thermal is nearby but pilot is circling at the edge
- **< 50%**: Broken lift, weak/disorganized thermal, or pilot searching

### 2.5 Circle Duration

```
duration = time[end] - time[start]
```

Typical: 20-35 seconds for a full circle in a thermal.

---

## 3. Wind Estimation from Thermal Circles

### 3.1 Ground Speed Min/Max (simplest, GPS-only)

During a steady circle, ground speed oscillates sinusoidally — wind adds to airspeed when flying downwind, subtracts when flying upwind.

```
wind_speed = (GS_max - GS_min) / 2
wind_direction = track_heading at GS_max   // flying with the wind when fastest
```

Requires clean, steady circles. Simple but noisy. Referenced in USGS publication OF-02-395.

### 3.2 Circle Center Drift (best for post-processing)

Fit circles to each revolution (Section 2.2), then compute the drift vector between consecutive circle centers:

```
for consecutive circles (c1, c2):
    dt = midpoint_time(c2) - midpoint_time(c1)
    dx = c2.center.x - c1.center.x
    dy = c2.center.y - c1.center.y

    wind_speed = sqrt(dx^2 + dy^2) / dt    // m/s
    wind_direction = atan2(dx, dy)          // direction wind is blowing TO
```

More accurate than ground speed oscillation because it uses geometric centers. Works well even in strong winds.

### 3.3 Sinusoidal Curve Fit (XCSoar CirclingWind)

Source: `XCSoar/src/Computer/Wind/CirclingWind.cpp`

Fit `ground_speed = mean + amplitude * cos(track - wind_direction)` over one complete circle using grid search over wind direction:

```
For each candidate wind_direction (grid search 0-360):
    For each sample:
        expected_speed_diff = wind_amplitude * cos(track[i] - wind_direction)
        residual = (ground_speed[i] - mean_speed) - expected_speed_diff
    fit_error = sum(residual^2)

Find wind_direction that minimizes fit_error
Refine with progressively smaller grid until resolution < 2 degrees

wind_speed = amplitude * (pi/2)  // average-to-amplitude correction
wind_direction = best_fit_direction + latency_correction(0.25s)

Quality check: reject if wind_speed > 30 m/s
Quality score (0-5) based on circle roundness and fit quality
```

**Known limitation** (XCSoar issue #1388): Degrades when wind speed exceeds about one-third of true airspeed. The quality metric `(max_d_alpha - avg_d_alpha) / avg_d_alpha` reaches 1.0 at wind_speed = TAS/2. Circle center drift (3.2) may be more robust in strong wind conditions.

---

## 4. XCSoar Thermal Locator (Lift-Weighted Center)

Source: `XCSoar/src/Computer/ThermalLocator.cpp`

Estimates the thermal center as a lift-weighted average position (not a circle fit):

```
for each sample during circling:
    weight = lift_value * recency_weight
    weighted_position += (position - reference_point) * weight
    total_weight += weight

thermal_center = weighted_position / total_weight + reference_point

// Wind drift compensation for map display:
for each historical thermal:
    drift = wind_vector * time_since_thermal
    ground_source = thermal_position - drift   // project to ground source
```

The map marker shows the **ground source** (compensated for wind drift), so returning at a lower altitude the marker predicts where the thermal will be (shifted downwind from the top).

---

## 5. US Patent 6,089,506: Thermal Center Flight Indicator

Uses lift-weighted position averaging for real-time thermal centering display:

```
center_xy = sum(position_i * lift_i) / sum(lift_i)
```

Only positive lift values contribute. A "center angle" is displayed showing the direction from the aircraft to the estimated thermal center, guiding the pilot to adjust their circle to center the thermal.

---

## 6. Key Threshold Comparison

| Parameter | XCSoar | igc_lib | ArduSoar | Current TaskScore |
|-----------|--------|---------|----------|-------------------|
| Turn rate threshold | 4 deg/s | 6 deg/s | N/A (uses vario) | Not implemented |
| Bearing lookback window | Adjacent fixes (smoothed) | 5 seconds | N/A | Not implemented |
| Min climb rate | N/A (separate) | N/A | SOAR_VSPEED (configurable) | 0.5 m/s |
| Min thermal duration | Via mode switch delays | 60 s | Via EKF convergence | 20 s |
| Smoothing method | Low-pass filter (0.3) | Viterbi HMM | Netto vario filter (tau=0.03) | Sliding window (10 fixes) |
| Circle min samples | 8 fixes | N/A | N/A | N/A |

---

## 7. Open Source Implementations

| Project | Language | Detection Method | Key Feature | URL |
|---------|----------|-----------------|-------------|-----|
| XCSoar | C++ | Turn rate > 4 deg/s + state machine | Real-time, wind estimation via sinusoidal fit | github.com/XCSoar/XCSoar |
| igc_lib | Python | Bearing rate > 6 deg/s + Viterbi HMM | Global optimal sequence classification | github.com/xiadz/igc_lib |
| OpenSoar | Python | Flight phase detection | Competition scoring integration | github.com/GliderGeek/opensoar |
| ArduSoar | C++ (ArduPilot) | Netto vario + EKF thermal model | Real-time thermal centering for UAVs | arxiv.org/abs/1802.08215 |
| thermal.kk7.ch | Web service | Aggregate analysis of many flights | Thermal hotspot maps | thermal.kk7.ch |
| GPLIGC | Perl/OpenGL | Climb rate + 3D visualization | Thermal climb rate statistics | github.com/scalvin1/GPLIGC |

### Key source files in XCSoar (github.com/XCSoar/XCSoar):

- `src/Computer/CirclingComputer.cpp` — State machine for circling detection
- `src/Computer/Wind/CirclingWind.cpp` — Sinusoidal wind estimation from circles
- `src/Computer/ThermalLocator.cpp` — Lift-weighted thermal center estimation
- `src/Computer/Wind/WindEKF.cpp` — Extended Kalman Filter wind estimation

### Key source files in igc_lib (github.com/xiadz/igc_lib):

- `igc_lib/igc_lib.py` — Main library with Viterbi HMM thermal detection

---

## 8. Academic & Reference Sources

- **ArduSoar paper**: "ArduSoar: An Open-Source Thermalling Controller for Resource-Constrained Autopilots" — arxiv.org/abs/1802.08215
- **ALOFT paper**: "Autonomous Locator of Thermals" — apps.dtic.mil/sti/pdfs/ADA614555.pdf
- **US Patent 6,089,506**: Thermal center flight indicator — patents.google.com/patent/US6089506A/en
- **USGS Wind Speed from GPS**: pubs.usgs.gov/of/2002/0395/pdf/of02-395.pdf
- **Least-Squares Circle Fitting**: scipy-cookbook.readthedocs.io/items/Least_Squares_Circle.html
- **XCSoar Wind Issue #1388**: Discussion on sinusoidal fit degradation in strong winds — github.com/XCSoar/XCSoar/issues/1388
- **Naviter/SeeYou Wind Measurements**: kb.naviter.com/en/kb/wind-measurements/
- **ParaglidingNet Thesis**: Sensor network for thermal research — thermal.kk7.ch/pdfs/ParaglidingNet_-_A_Sensor_Network_for_Thermal_Research.pdf
- **rec.aviation.soaring**: Wind speed estimation from GPS discussion — groups.google.com/g/rec.aviation.soaring/c/rpS-EsklVXE

---

## 9. Recommended Implementation Approach

Practical upgrade path for TaskScore, leveraging existing `geo.ts` primitives (`calculateBearing`, `andoyerDistance`):

### Phase 1: Circling Detection

Add bearing rate computation with 3-5 second lookback window. Use XCSoar-style threshold (4-5 deg/s) + four-state machine with hysteresis. Simpler than Viterbi HMM and effective for 1Hz IGC data.

Combine with existing climb rate check: **thermal = circling AND climbing**. This solves the documented limitation of ridge lift being classified as thermals.

### Phase 2: Individual Circle Extraction

Use cumulative heading change (Section 1.3) to segment each thermal into individual circles. Record start/end fixes, turn direction, and duration per circle.

### Phase 3: Per-Circle Parameters

Add least-squares circle fitting (Section 2.2) for each circle to get center point and radius. Compute climb rate, quality (% lifting), and duration per circle.

### Phase 4: Wind Estimation

Use circle center drift (Section 3.2) between consecutive circles for wind speed and direction estimates. Cross-check with ground speed min/max method (Section 3.1).

### Phase 5: Comparison & Tuning

Implement multiple detection methods side-by-side and compare results on real IGC files:
- Bearing rate threshold: try 4, 5, 6 deg/s
- State machine vs Viterbi HMM
- Circle drift vs sinusoidal fit for wind
