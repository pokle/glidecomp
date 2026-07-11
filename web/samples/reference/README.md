# Reference sample files

Raw reference material kept for tests — files in formats GlideComp does **not**
natively ingest (or does not yet). Unlike `web/samples/comps/`, nothing here is a
seedable/scoreable competition, and **nothing here is served publicly**: the Vite
build only copies `web/samples/comps/` into `dist/data/comps/`, so this directory
never ships to the website.

Use these as fixtures when building or testing importers/parsers for new formats,
or as ground-truth to compare GlideComp's output against.

## Contents

- `hg-worlds-2026/` — 22nd FAI European Hang Gliding Class 1 & 11th FAI World
  Hang Gliding Class 5 Championships (Italy, 2026). Task waypoints (7 formats),
  the OpenAir airspace definition used for violation penalties, and per-task
  official results pages saved from civlcomps.org.
