/**
 * The task form's rules (Add task, Task settings), pure so they are tested:
 * a date is a real YYYY-MM-DD, a task flies at least one of the comp's
 * classes, and a task name is required — the server's own checks, asked
 * before a write rather than after.
 */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export function taskFormProblem(form: { name: string; date: string; classes: string[] }): string | null {
  if (!form.name.trim()) return 'A task needs a name.';
  if (!isIsoDate(form.date)) return 'Enter the date as YYYY-MM-DD.';
  if (form.classes.length === 0) return 'Choose at least one class.';
  return null;
}

/** The next free "Task N" name, counting the comp's existing tasks. */
export function nextTaskName(existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((t) => t.name.trim().toLowerCase()));
  for (let n = existing.length + 1; ; n++) {
    const name = `Task ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Toggle one class in a selection, keeping the comp's own order. */
export function toggleClass(selected: readonly string[], cls: string, order: readonly string[]): string[] {
  const next = new Set(selected);
  if (next.has(cls)) next.delete(cls);
  else next.add(cls);
  return order.filter((c) => next.has(c));
}
