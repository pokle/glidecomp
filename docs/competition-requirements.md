# Competition Management Requirements

A Hang Gliding and Paragliding competition scoring assistant to help manage the tedious parts of scoring such a competition.

## Jobs to be done

Scorers (Admins):
- Create competitions
  - name
  - contacts
    - scorer
    - admin
    - committee 
  - scoring parameters (from `web/engine/cli/score-task.ts` CLI help)
    - `--nominal-distance <m>` — Nominal distance in meters (default: 70% of task distance)
    - `--nominal-time <s>` — Nominal time in seconds (default: 5400)
    - `--nominal-goal <ratio>` — Nominal goal ratio 0-1 (default: 0.2)
    - `--nominal-launch <ratio>` — Nominal launch ratio 0-1 (default: 0.96)
    - `--min-distance <m>` — Minimum distance in meters (default: 5000)
    - `--scoring <PG|HG>` — Sport type (default: HG)
    - `--no-leading` — Disable leading (departure) points
    - `--no-arrival` — Disable arrival points
- Create or edit a registered list of pilots for a competition
  - pilot class examples:
    - open
      - A-grade
      - open
    - kingpost/sport
    - floater
      - novice
      - vetran
  - pilot identifiers from sporting bodies (SAFA, CIVL, etc...)
  - pilot's CIVL world ranking
  - team name (groups pilots into teams for scoring purposes)
  - driver's contact information (name, phone, radio channel, etc...)
  - pilot's contact information (email, phone, etc...)
- Create or re-use waypoint files for a competition.
- Create a task for a competition day (Tasks composed of waypoints - start, ... goal)
- Manage task scores
  - Penalties
  - Manually submit scores when pilots have lost their track files
- Manage pilot starting order for a task
  - First task is in reverse order of the CIVL world ranking order
  - Subsequent days are in reverse order of the previous day's scores

Pilots:
- View a day's task
  - Start order
  - Waypoints
    - QR code
    - Download xctsk file
  - Scores
  - Everyone's tracks on a map
  - Download everyone's tracks
- Can submit their IGC track files for a particular competition task
  - email it to a comp email address
  - uploaded it to a web page
- Pilots can edit their own profiles (same information as the registered list of pilots)

Public:
- View tasks for a competition day
  - Waypoints
    - QR code
    - Download xctsk file
- View scores for a task
- View scores for the whole competition
- Group scores by overall, pilot class, or team
