/**
 * A task's stopped and closed states in words (stage 2: "the card with
 * stopped and closed states in words"). The wording follows the website's
 * task page, so a pilot reads the same sentence on both.
 */
import { formatTaskDate, isPastCloseDate } from '@glidecomp/client/format';
import { formatInstant } from '@glidecomp/client/time';
import type { CompDetailData, TaskDetailData } from '@glidecomp/client/types';

export interface StatusLine {
  title: string;
  detail: string;
}

export function taskStatusLines(
  task: Pick<TaskDetailData, 'stop_announcement_time' | 'submissions_closed'>,
  comp: Pick<CompDetailData, 'close_date' | 'timezone'> | undefined,
): StatusLine[] {
  const lines: StatusLine[] = [];
  if (task.stop_announcement_time) {
    lines.push({
      title: 'Task stopped',
      detail: `Stop announced ${formatInstant(
        new Date(task.stop_announcement_time),
        comp?.timezone ?? 'UTC',
      )} — scored as a stopped task (FAI S7F §13.4)`,
    });
  }
  if (task.submissions_closed) {
    lines.push({
      title: 'Closed for track submissions',
      detail: 'The organisers are no longer accepting tracks for this task.',
    });
  } else if (comp && isPastCloseDate(comp.close_date)) {
    lines.push({
      title: 'Competition closed',
      detail: `Tracks were accepted until ${formatTaskDate(comp.close_date!, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}.`,
    });
  }
  return lines;
}
