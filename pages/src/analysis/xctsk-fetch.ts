/**
 * XContest task fetch functions (browser-only, uses fetch API).
 * Pure parsing logic lives in @taskscore/analysis.
 */

import { parseXCTask, isValidTask, type XCTask } from '@taskscore/analysis';

export interface FetchTaskResult {
  task: XCTask;
  rawJson: string;
}

/**
 * Fetch task from XContest by task code
 */
export async function fetchTaskByCode(code: string): Promise<XCTask> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    throw new Error('Task code cannot be empty');
  }

  const url = `https://tools.xcontest.org/api/xctsk/load/${encodeURIComponent(cleanCode)}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task code "${cleanCode}" not found`);
    }
    throw new Error(`Failed to fetch task: HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim().startsWith('{')) {
    throw new Error(`Invalid response from server: expected JSON`);
  }

  const task = parseXCTask(text);
  if (!isValidTask(task)) {
    throw new Error('Task has invalid or missing coordinates');
  }

  return task;
}

/**
 * Fetch task from XContest by task code, returning both parsed task and raw JSON.
 */
export async function fetchTaskByCodeWithRaw(code: string): Promise<FetchTaskResult> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    throw new Error('Task code cannot be empty');
  }

  const url = `https://tools.xcontest.org/api/xctsk/load/${encodeURIComponent(cleanCode)}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task code "${cleanCode}" not found`);
    }
    throw new Error(`Failed to fetch task: HTTP ${response.status}`);
  }

  const rawJson = await response.text();
  if (!rawJson.trim().startsWith('{')) {
    throw new Error(`Invalid response from server: expected JSON`);
  }

  const task = parseXCTask(rawJson);
  if (!isValidTask(task)) {
    throw new Error('Task has invalid or missing coordinates');
  }

  return { task, rawJson };
}
