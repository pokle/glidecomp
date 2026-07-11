# Hang Gliding Worlds 2026 — reference files

Source event: **22nd FAI European Hang Gliding Class 1 & 11th FAI World Hang
Gliding Class 5 Championships** (Italy, 2026). Task waypoints are around the
Bordano / Gemona / Friuli area.

These are reference fixtures in non-GlideComp formats. Not seeded, not scored,
not served publicly (see `../README.md`).

## waypoints/

The same waypoint set exported from GpsDump in seven formats. All describe the
same points (landings `A##`, turnpoints, etc.); they differ only in encoding —
useful for testing coordinate parsing across formats.

| File                                  | Format               | Notes |
|---------------------------------------|----------------------|-------|
| `hg1euro-hg5worlds-2026_FS.wpt`        | FS / `$FormatGEO`    | Deg-min-sec, `N 46 18 31.78` |
| `hg1euro-hg5worlds-2026_CompeGPS.wpt`  | CompeGPS `.wpt`      | |
| `hg1euro-hg5worlds-2026_OZI.wpt`       | OziExplorer `.wpt`   | Decimal degrees |
| `hg1euro-hg5worlds-2026_UTM.WPT`       | UTM `.wpt`           | Projected easting/northing |
| `hg1euro-hg5worlds-2026_SeeYou.cup`    | SeeYou `.cup`        | CSV, `4618.530N` deg-decimalmin |
| `hg1euro-hg5worlds-2026_GPX.gpx`       | GPX 1.1              | XML `<wpt>` decimal degrees |
| `hg1euro-hg5worlds-2026_GoogleEarth.KML`| KML                 | XML, `lon,lat,elev` |

Filenames are kept verbatim from the source download.

## airspace/

- `Version-2_Airspaces_hg1euro-hg5worlds-2026_OpenAir.txt` — **OpenAir** format
  (`AC`/`AN`/`AL`/`AH`/`DP` records) defining the event's prohibited areas,
  restricted areas and boundary zones. This is the airspace definition that was
  used to score **airspace-violation penalties** for the championship.

  GlideComp does not have airspace-violation scoring yet — kept here as reference
  for a future feature (parse OpenAir → test tracks against zones → penalties).

## results/

Per-task **Overall** scores pages saved from
`civlcomps.org/event/hg1euro-hg5worlds-2026/results` (the official CIVL results) —
the final ranked results for each task. Full standalone HTML dumps (each ~350 KB,
styling/scripts inlined by the browser "Save Page" action), useful as ground-truth
to compare GlideComp's own scoring against.

- `task-1-overall.html` … `task-5-overall.html`, `task-7-overall.html`,
  `task-8-overall.html`

Renamed from the original `…Championships|Task N Ov.html` for clean paths
(`Ov` = "Overall"). Note: **there is no Task 6** in the source download (only
tasks 1–5, 7, 8 were saved). Add it here if it becomes available.


