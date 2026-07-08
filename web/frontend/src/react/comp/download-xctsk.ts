/**
 * Public "Download .xctsk" (IA v2 #277): pilots load the day's task into
 * their flight instruments. The task's xctsk JSON is already public via the
 * task API; this just serializes it back to a .xctsk file client-side.
 */
import { toXctskJSON, type XCTask } from "@glidecomp/engine";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";

export function downloadXctskFile(taskName: string, task: XCTask): void {
  downloadFile(
    `${slugify(taskName)}.xctsk`,
    JSON.stringify(toXctskJSON(task)),
    "application/xctsk+json"
  );
}

/**
 * Fetch-then-download for callers that only hold a task summary (the comp
 * page hero). Throws on network / missing-route errors — callers toast.
 */
export async function downloadTaskXctsk(
  compId: string,
  taskId: string,
  taskName: string
): Promise<void> {
  const res = await api.api.comp[":comp_id"].task[":task_id"].$get({
    param: { comp_id: compId, task_id: taskId },
  });
  if (!res.ok) throw new Error("Task not available");
  const data = (await res.json()) as unknown as { xctsk: XCTask | null };
  if (!data.xctsk) throw new Error("No route defined for this task yet");
  downloadXctskFile(taskName, data.xctsk);
}
