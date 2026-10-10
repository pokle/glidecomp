/**
 * GET /api/comp/search — the site search over competitions, tasks (with
 * their turnpoints) and pilots. See docs/2026-08-01-site-search.md.
 */

/** Below this many characters, the server is not asked at all. */
export const MIN_SEARCH_CHARS = 2;

export interface SearchPilot {
  comp_pilot_id: string;
  name: string;
}

export interface SearchTask {
  task_id: string;
  name: string;
  task_date: string;
  matched: boolean;
  matched_turnpoints: string[];
  pilots: SearchPilot[];
  pilot_count: number;
}

export interface SearchComp {
  comp_id: string;
  name: string;
  category: string;
  test: boolean;
  scoring_format: string;
  matched: boolean;
  task_count: number;
  tasks: SearchTask[];
  pilots: SearchPilot[];
}

export interface SearchResults {
  terms: string[];
  comps: SearchComp[];
  truncated: boolean;
}
