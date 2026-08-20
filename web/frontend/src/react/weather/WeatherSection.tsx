/**
 * The task page's "Weather" section: the organizer's notes on what the day
 * actually did, followed by the modelled conditions (TaskWeatherPanel) —
 * the same charts the field-analysis report leads with. The conditions are
 * context for reading everything below them on the page, which is why this
 * sits under the route and above the results.
 *
 * Notes are public to READ (anyone who can see the task sees them),
 * admin-only to WRITE. That asymmetry is the point of the feature: the
 * modelled weather is a grid cell kilometres wide, and the people who ran
 * the day know things it cannot — that the cycle went through at one, that
 * the valley wind switched, that half the field got flushed off launch.
 *
 * Rendered for admins even when there is nothing yet, so there is somewhere
 * to click to add the first note; hidden from everyone else only when there
 * is nothing to read at all — no notes, no charts, and no answer on its way.
 *
 * Notes are not a scoring input. Saving goes through the task PATCH like
 * every other task field, which audit-logs the change (with an excerpt,
 * since this is prose) and deliberately does NOT mark scores stale.
 *
 * Editing happens on a routed page, not here (issue #637): the section owns
 * the READING of the notes and links to
 * comp/settings/WeatherNotesSettings.tsx for the writing. An eight-row
 * textarea in a centred modal was the shape that conversion exists to remove.
 */
import { LinkButton } from "@/react/rac/button";
import { SectionHeader } from "@/react/components/SectionHeader";
import { WeatherNotesBlock } from "./WeatherNotesBlock";
import { TaskWeatherPanel } from "./TaskWeatherPanel";
import type { TaskWeatherState } from "./use-task-weather";
import { Card } from "@/react/rac/card";

export function WeatherSection({
  weather,
  notes,
  isAdmin,
  compTimezone,
  notesHref,
}: {
  /**
   * Fetched by the page and handed down, not fetched here. The task page's
   * route views want the same answer for their wind, and the endpoint can
   * schedule a background provider fetch — so it is asked once.
   */
  weather: TaskWeatherState;
  notes: string;
  isAdmin: boolean;
  /** Competition IANA zone; the charts' axis ticks in it. */
  compTimezone: string | null;
  /**
   * Where the notes are edited. Built by the caller, which holds the comp and
   * task names the canonical slug needs — this section knows about weather,
   * not about URL shapes.
   */
  notesHref: string;
}) {
  const hasNotes = notes.trim().length > 0;

  const weatherPending = weather.loading || weather.data?.pending === true;
  const hasWeather = weatherPending || weather.data?.weather != null;
  // A task set beyond the forecast horizon explains itself in the panel, but
  // it doesn't open the section on its own: for a reader with nothing else to
  // see here, "no weather yet" is noise. The admin who scheduled the comp
  // that far ahead always has the section open, and gets the explanation.
  const tooFarAhead = weather.data?.too_far_ahead === true;

  if (!hasNotes && !hasWeather && !isAdmin) return null;

  return (
    <Card>
      <SectionHeader
        title="Weather"
        action={
          isAdmin ? (
            <LinkButton variant="outline" size="sm" href={notesHref}>
              {hasNotes ? "Edit notes" : "Add notes"}
            </LinkButton>
          ) : null
        }
      />
      {hasNotes ? (
        <WeatherNotesBlock notes={notes} className="mt-2 text-sm whitespace-pre-line" />
      ) : isAdmin ? (
        <p className="mt-2 text-muted-foreground">
          No weather notes yet. Record what the day did — the conditions pilots
          flew in are context the scores can&rsquo;t show.
        </p>
      ) : null}
      {hasWeather || tooFarAhead ? (
        <div className="mt-3">
          <TaskWeatherPanel
            weather={weather.data?.weather ?? null}
            compTimezone={compTimezone}
            pending={weatherPending}
            tooFarAhead={tooFarAhead}
          />
        </div>
      ) : null}
    </Card>
  );
}
