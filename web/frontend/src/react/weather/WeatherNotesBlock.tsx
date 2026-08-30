/**
 * The organizer's weather notes, rendered read-only.
 *
 * Plain text, deliberately: notes are typed by comp organizers on a
 * competition evening and the value is in the observation, not the markup.
 * Rendering them as a React text node also means no sanitiser is load-bearing
 * — there is no path from this field to HTML. Line breaks survive via
 * `whitespace-pre-line`, which is the only formatting a note like
 * "overdeveloped by 2pm / glass off at 3" actually needs.
 *
 * Shared by the task page's Weather section and the task-analysis page's
 * weather section so the two can never drift into showing the same text
 * differently.
 */
export function WeatherNotesBlock({
  notes,
  className,
}: {
  notes: string;
  className?: string;
}) {
  const text = notes.trim();
  if (!text) return null;
  return (
    <p className={className ?? "text-sm whitespace-pre-line text-muted-foreground"}>
      {text}
    </p>
  );
}
