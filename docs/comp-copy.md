# Starting the next competition from one that exists

Most of a competition is the same as last year's: the same wing, classes and
scoring, the same waypoint file, and most of the same pilots. Three pages let
an organiser start from what is already there.

| Page | Reached from | Server |
|---|---|---|
| `/comp/:id/copy` | Settings → **Copy to a new competition** | `POST /api/comp/:id/clone` |
| `/comp/:id/pilots/copy` | Pilots ⋯ → **Copy from another competition…** | `GET /api/comp/:id/pilot/copy-sources`, `GET` / `POST /api/comp/:id/pilot/copy` |
| `/comp/:id/task/:t/route/copy` | Route editor → **Copy from another competition** | `GET /api/comp/:id/task/:t/route-sources` |

All three pages are admin-only and are served as noindex shells by
`functions/comp/[[path]].ts`. Each one keeps its state in the URL, so Back and
a reload work as they do on any other page.

## Copying a competition

Code: `web/workers/competition-api/src/routes/comp-copy.ts`,
`web/frontend/src/react/pages/CompCopyPage.tsx`.

The copy is a new competition. The organiser who copies it is its organiser.

**Always copied:** the settings. These are the wing (`category`), the pilot
classes and the default class, the scoring format, the GAP parameters
(including the HG Class 2 classes), series scoring and the FTV factor, the
timezone, open uploads and open registration.

**Copied unless the organiser unticks it:**

- the waypoints (`comp_waypoints`, copied inside the database);
- the pilots (see "Copying pilots", below);
- the other organisers (`comp_admin` rows).

**Never copied:**

- the tasks. A task is set on the day. To use a route again, copy it into the
  new task's route editor.
- the close date. The copy gets one month from today, as a new competition
  does.
- the organiser's notes. These are usually about one year.
- the share key. The copy gets a new one.

The copy is **hidden** (`test = 1`), as every new competition is. Its
`settings_reviewed` is 0, so the setup guide asks the organiser to review the
settings. The close date is new, so the review is necessary.

The new competition's audit log records the copy: one line that names the
source and what came with it, and the pilot lines described below. The source
competition's log does not change.

A copy counts towards the 50 competitions an account can organise.

## Copying pilots

Code: `web/workers/competition-api/src/roster-copy.ts` (used by the clone too),
`web/frontend/src/react/pages/CompPilotsCopyPage.tsx`.

A copy **adds** pilots. It does not change or remove a pilot who is already on
the roster.

- **Only from a competition the caller organises.** A roster holds emails and
  phone numbers. If the caller is not an organiser of the source, the server
  answers "not found", whether the competition is hidden or not.
- **Already here** means the same GlideComp account, any of the same
  sporting-body IDs, or the same email (the registered one or the linked
  account's). These pilots are listed with the reason and are not copied.
- **A name alone never decides.** A pilot with the same name as someone on the
  roster is copied. The review page shows the two names together, so that the
  organiser can delete one if they are the same person. This is the rule in
  CLAUDE.md: names may propose, never dispose.
- **Links to accounts.** A linked source row stays linked. The source is a
  competition the caller organises, so the link is already established. An
  unlinked row goes through the import's resolver (`pilot-resolver.ts`: an ID,
  then an email, never a name alone).
- **Classes.** A class that the target competition does not have becomes the
  target's default class. The review page says so.
- **Teams** go through `TeamSpellings`, as every write of `team_name` does.
- **Left behind:** the WPRS points and where they came from (a ranking as it
  stood in one month; use "Fill from CIVL" again), and the first start order
  (one year's launch order).

A copied pilot has no tracks, manual flights or statuses. Thus no task score
changes, and nothing is marked stale. The audit log gets one line for each
pilot, up to five pilots. For more than five, it gets one summary line. This
is the same rule as the bulk save.

## Copying a route

Code: `web/workers/competition-api/src/route-sources.ts` and
`routes/route-copy.ts`, `web/frontend/src/react/pages/TaskRouteCopyPage.tsx`.

The list holds every task with a saved route in a competition that the caller
can see (`visibleCompsFilter`), except the task itself. A hidden competition
is listed only for its organisers. This competition's other tasks are listed
too.

**The order is nearest first.** The distance is measured from each route's
first turnpoint (its take-off) to the **nearest** point that this competition
already knows about: one of its waypoints, or a turnpoint of one of its routes.
The nearest point is used, not a centre, because a regional waypoint file can
cover 300 km. Routes within a kilometre of each other are listed newest first.
When the competition knows no point yet, the whole list is newest first.

The distance only sorts the list. It never removes a route from it. The search
box narrows the list by words in the competition name or the task name. The
distances are WGS84 geodesics from `geo.ts`. They are exact: a chord through
the ellipsoid is a lower bound on the geodesic (`chordLowerBound`), so most
Vincenty calls can be skipped without changing the answer.

When the organiser chooses a route, the route editor opens with
`?from_comp=…&from_task=…`. It fetches that task through the ordinary task
route and loads it as **unsaved** work. Save is the ordinary route save, with
its own checks, audit entry and score bump.

Start gates, the goal deadline and the take-off window keep their **local**
time (`rebaseRouteTimes()` in `comp/comp-copy.ts`). An `.xctsk` stores these
as UTC times of day. Thus a 12:30 start copied from January to April would
otherwise move to 11:30 when daylight saving ends.
