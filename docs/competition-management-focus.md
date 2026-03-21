# TaskClaw

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
  - pilot class
    - open
      - A-grade
      - open
    - kingpost/sport
    - floater
      - novice
      - vetran
  - pilot identifiers from sporting bodies (SAFA, CIVL, etc...)
  - CIVL world ranking
  - team
- Create or re-use waypoint files for a competition.
- Create tasks within competitions.
- Create a task for a competition day (Tasks composed of waypoints - start, ... goal)
- Manage task scores
  - Penalties
  - Manually submit scores when pilots have lost their track files
- Manage pilot starting order for a task
  - First task is in reverse order of the CIVL world ranking order
  - Subsequent day

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
- Pilots can edit their own profiles
  - pilot class
  - pilot identifiers
  - team

Public:
- View scores for a task
- View scores for the whole competition
- Group scores by overall, pilot class, or team
