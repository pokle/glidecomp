/**
 * A comp's tasks grouped by day, every task alike (#514): no task is
 * featured, and a day flown by several classes lists each of its tasks.
 * Days run newest first, the order a pilot mid-comp wants.
 */
import type { TaskSummary } from '@glidecomp/client/types';

export interface TaskDay {
  date: string;
  tasks: TaskSummary[];
}

export function groupTasksByDay(tasks: readonly TaskSummary[]): TaskDay[] {
  const byDate = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const list = byDate.get(task.task_date) ?? [];
    list.push(task);
    byDate.set(task.task_date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, list]) => ({ date, tasks: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}
