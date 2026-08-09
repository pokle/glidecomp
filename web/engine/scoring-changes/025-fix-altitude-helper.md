# fixAltitude helper

FixAltitude helper added to igc-parser (GNSS→pressure fallback on the
zero sentinel). Scoring behaviour itself is unchanged — the helper is
consumed by the flight-phase detectors and field analysis, not the
scorers — so this bump is the guard's "harmless extra cache roll".
