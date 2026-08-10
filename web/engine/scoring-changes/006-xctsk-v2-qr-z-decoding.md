# xctsk v2 QR `z` decoding

Xctsk v2 QR `z` decoding — the polyline tuple is read in the spec's
(longitude, latitude, altitude, radius) order instead of latitude-first
(https://xctrack.org/Competition_Interfaces.html), and each value is
decoded standalone (no delta accumulation). Tasks imported from compact
QR payloads without explicit lat/lon fields previously had their
coordinates transposed.
