# TaskScore macOS App

Native macOS app for analyzing hanggliding/paragliding competition track logs. Built with SwiftUI and Swift Package Manager.

## Requirements

- macOS 14+
- Swift 5.9+

## Build & Run

```bash
# Build (debug)
swift build

# Build (release)
swift build -c release

# Run the app
swift run TaskScore

# Run tests
swift test
```

## Build .app Bundle

To create a standalone `TaskScore.app` for distribution or installing in `/Applications`:

```bash
./build-app.sh

# Then either:
open TaskScore.app
# Or copy to Applications:
cp -R TaskScore.app /Applications/
```

## CLI: detect-events

A command-line tool for detecting flight events from IGC files. Outputs CSV to stdout.

```bash
# IGC file only (task is optional)
swift run detect-events <flight.igc>

# IGC file with task
swift run detect-events <flight.igc> [task.xctask]

# Example with sample flights
swift run detect-events \
  TaskScore/Resources/SampleFlights/durand_45515_050126.igc \
  TaskScore/Resources/SampleFlights/buje.xctask
```

## Project Structure

```
Package.swift        - Swift Package Manager manifest
TaskScore/           - macOS app (SwiftUI)
TaskScoreLib/        - Shared analysis library (no SwiftUI dependency)
TaskScoreTests/      - Tests (Swift Testing framework)
CLI/                 - Command-line tools (detect-events)
build-app.sh         - Script to build .app bundle
```
