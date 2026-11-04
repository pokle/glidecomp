/**
 * The refusals about pilot classes, in the words an organiser reads.
 *
 * Each names the input it is about (`field`), so a settings page's kit form
 * (`rac/form.tsx`) shows it UNDER that field — "Default pilot class", "FAI
 * Class 2 classes", a task's "Pilot classes". A sentence that lands under a
 * field is read by the organiser who filled it in, so it says which class is
 * the problem and which classes there are, never a column name.
 *
 * Pure, so the comp create and update routes ask the same question and give
 * the same answer: they each carried their own copy until 2026-11.
 */

/** A refusal about one input, named as the API names it. */
export interface ClassRefusal {
  error: string;
  field: string;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quoted(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** `"x" is not one of …` / `"x" and "y" are not among …`, with the classes. */
function notAmong(unknown: readonly string[], classes: readonly string[]): string {
  const verb = unknown.length === 1 ? "is not one of" : "are not among";
  return `${quoted(unknown)} ${verb} this competition's pilot classes (${classes.join(", ")})`;
}

/**
 * Whether a competition's class settings hang together, as they will be after
 * the save: the default class must be one of the classes, and the FAI Class 2
 * list (S7F §11) may name only classes the competition has.
 *
 * @param classes      the pilot classes after the save
 * @param defaultClass the default class after the save, or null when the save
 *                     touches neither it nor the class list (nothing to check)
 * @param class2       the classes marked as FAI Class 2 after the save
 */
export function classRefusal(
  classes: readonly string[],
  defaultClass: string | null,
  class2: readonly string[]
): ClassRefusal | null {
  if (defaultClass !== null && !classes.includes(defaultClass)) {
    return {
      error: `${notAmong([defaultClass], classes)}, so it cannot be the default pilot class.`,
      field: "default_pilot_class",
    };
  }
  const unknownClass2 = class2.filter((cls) => !classes.includes(cls));
  if (unknownClass2.length > 0) {
    return {
      error: `${notAmong(unknownClass2, classes)}, so ${
        unknownClass2.length === 1 ? "it" : "they"
      } cannot fly FAI Class 2.`,
      field: "gap_params.hgClass2Classes",
    };
  }
  return null;
}

/**
 * Whether a task's pilot classes are all the competition's. A task is flown
 * by some of the competition's classes, never by one it does not have.
 */
export function taskClassRefusal(
  compClasses: readonly string[],
  taskClasses: readonly string[]
): ClassRefusal | null {
  const unknown = taskClasses.filter((cls) => !compClasses.includes(cls));
  if (unknown.length === 0) return null;
  return { error: `${notAmong(unknown, compClasses)}.`, field: "pilot_classes" };
}
