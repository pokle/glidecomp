/**
 * The pure parts of starting the next competition from one that exists:
 * the name the copy page suggests, and keeping a copied route's start gates
 * at the same LOCAL time on the new day.
 *
 * The pages are pages/CompCopyPage.tsx (the clone), CompPilotsCopyPage.tsx
 * (copying a roster in) and TaskRouteCopyPage.tsx (choosing a route to copy).
 */
import type { XCTask } from "@glidecomp/engine";
import { utcToZonedHHMM, zonedToUtcHHMM } from "../lib/time";
import { gateToHHMM } from "./route";

/** The longest name the server accepts (competition-api's validators.ts). */
const MAX_NAME = 128;

/**
 * A name for the copy: the same name with its year moved on by one
 * ("Corryong Cup 2026" → "Corryong Cup 2027"), which is what a copy is for
 * most of the time. A name with no year gets "(copy)" after it, so the two
 * competitions are never listed under one name by accident.
 *
 * Only the LAST year in the name moves: "2025/26 Winter Series 2026" is a
 * name nobody should have to think about, and the last year is the likelier
 * one to be the edition.
 */
export function suggestCopyName(name: string): string {
  const trimmed = name.trim();
  const years = [...trimmed.matchAll(/(?<!\d)(19|20)\d{2}(?!\d)/g)];
  const last = years[years.length - 1];
  if (last && last.index !== undefined) {
    const next = String(Number(last[0]) + 1);
    return (
      trimmed.slice(0, last.index) + next + trimmed.slice(last.index + last[0].length)
    ).slice(0, MAX_NAME);
  }
  const suffix = " (copy)";
  return `${trimmed.slice(0, MAX_NAME - suffix.length)}${suffix}`;
}

/** "09:05" → "09:05:00Z", the .xctsk's way of writing a UTC time of day. */
function asXctskTime(hhmm: string): string {
  return `${hhmm}:00Z`;
}

/**
 * A route copied from another day, with every time of day in it moved so it
 * reads the same on THIS day's clock.
 *
 * An .xctsk stores its start gates, goal deadline and take-off window as UTC
 * times of day, with no date. A start at 12:30 in January in Corryong is
 * 01:30 UTC; the same 01:30 UTC in April, after daylight saving ends, is
 * 11:30 on the hill. An organiser copying last summer's route into an
 * autumn task means 12:30, so each time is read on the day it came from and
 * written for the day it goes to, both in the competition's zone.
 *
 * With no zone (a competition that has not set or derived one) there is
 * nothing to convert between, and the route comes back as it was. A time
 * this cannot read is left exactly as it was.
 */
export function rebaseRouteTimes(
  task: XCTask,
  fromDate: string,
  toDate: string,
  timeZone: string | null
): XCTask {
  if (!timeZone || fromDate === toDate) return task;
  const move = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const utc = gateToHHMM(value);
    if (!utc) return value;
    const local = utcToZonedHHMM(fromDate, utc, timeZone);
    const back = local ? zonedToUtcHHMM(toDate, local, timeZone) : null;
    return back ? asXctskTime(back) : value;
  };
  const out: XCTask = { ...task };
  if (task.sss) {
    out.sss = {
      ...task.sss,
      ...(task.sss.timeGates
        ? { timeGates: task.sss.timeGates.map((g) => move(g) ?? g) }
        : {}),
    };
  }
  if (task.goal) {
    out.goal = {
      ...task.goal,
      ...(task.goal.deadline !== undefined ? { deadline: move(task.goal.deadline) } : {}),
    };
  }
  if (task.takeoff) {
    out.takeoff = {
      ...task.takeoff,
      ...(task.takeoff.timeOpen !== undefined ? { timeOpen: move(task.takeoff.timeOpen) } : {}),
      ...(task.takeoff.timeClose !== undefined ? { timeClose: move(task.takeoff.timeClose) } : {}),
    };
  }
  return out;
}

/** "12 km away", "under 1 km away", or nothing when there is no distance. */
export function formatRouteDistance(metres: number | null): string | null {
  if (metres === null) return null;
  if (metres < 1000) return "under 1 km away";
  return `${Math.round(metres / 1000).toLocaleString("en-AU")} km away`;
}
