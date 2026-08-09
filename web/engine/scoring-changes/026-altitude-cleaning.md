# Altitude cleaning

Altitude cleaning — parseIGC now runs a plausibility pass (GNSS-vs-
baro rolling-residual cross-check, vertical-rate excursion rule for
single-channel tracks) that repairs glitch fixes into
IGCFix.cleanedAltitude, and every altitude consumer (detectors,
turnpoint crossings/altitude bonus, takeoff/landing, glide speed)
reads through fixAltitude(). Scores only move where a track carried a
GPS altitude glitch on a fix that mattered.
