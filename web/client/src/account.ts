/**
 * The signed-in account, as both clients read it: who it is, whether it has
 * still to be onboarded, the pilot profile's fields, and the comps it is on.
 *
 * Moved from the website (src/auth/client.ts, react/pages/Settings.tsx) for
 * the app's Me tab (mobile plan, stage 4), so the two ask one onboarding
 * question and label one set of fields.
 */

/** GET /api/auth/me → `user`. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
}

/**
 * Has this account still to be onboarded? The ONE definition of the gate —
 * Shell, the dashboard, the analysis page, onboarding itself and the app all
 * ask here, so they can't drift apart and strand someone in a redirect loop.
 *
 * Both halves matter, and each is the sole signal for a different sign-up
 * path. A username is auto-derived at sign-up so a Google user never has to
 * pick one by hand — but that derivation also fires for email-OTP sign-ups,
 * which arrive with `name: ""` and so used to sail past a username-only gate
 * with nothing but a handle guessed off their email address. Nothing else in
 * the app ever asks for a display name, so the account stayed nameless.
 *
 * `name` is `"user".name` (the account's own display name, what /api/auth/me
 * and the header show), NOT the pilot profile's — those are separate fields.
 * Onboarding writes both.
 */
export function needsOnboarding(user: AuthUser): boolean {
  return !user.username || user.name.trim() === "";
}

// Names and contact details on one side, pilot registration IDs on the other.
export const NAME_CONTACT_FIELDS = [
  { key: "name", label: "Display name" },
  { key: "phone", label: "Phone" },
  { key: "glider", label: "Glider" },
  { key: "emergency_contact_name", label: "Emergency contact name" },
  { key: "emergency_contact_phone", label: "Emergency contact phone" },
] as const;

export const ID_FIELDS = [
  { key: "civl_id", label: "CIVL ID" },
  { key: "safa_id", label: "SAFA ID" },
  { key: "ushpa_id", label: "USHPA ID" },
  { key: "bhpa_id", label: "BHPA ID" },
  { key: "dhv_id", label: "DHV ID" },
  { key: "ffvl_id", label: "FFVL ID" },
  { key: "fai_id", label: "FAI ID" },
] as const;

export const PROFILE_FIELDS = [...NAME_CONTACT_FIELDS, ...ID_FIELDS] as const;

export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]["key"];

/** GET /api/comp/pilot — the account's pilot profile; unset fields are null. */
export type PilotProfile = Record<ProfileFieldKey, string | null>;

/** GET /api/comp/pilot/registrations — one roster row this account holds. */
export interface PilotRegistration {
  comp_id: string;
  comp_pilot_id: string;
  registered_pilot_name: string;
  pilot_class: string;
}

/** GET /api/comp/pilot/flights — one flight (track or manual) this account flew. */
export interface PilotFlight {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_pilot_id: string;
  kind: "track" | "manual";
  recorded_at: string;
  rank: number | null;
  class_size: number | null;
  total_score: number | null;
}

// ── The personal library (`/api/user/tracks`, `/api/user/tasks`) ────────────

/** GET /api/user/tracks — one track in the account's own library. */
export interface LibraryTrack {
  track_id: string;
  filename: string;
  display_name: string;
  pilot: string | null;
  glider: string | null;
  flight_date: string | null;
  /** Bytes stored (gzipped), which is what the allowance counts. */
  file_size: number;
  stored_at: string;
  last_accessed_at: string;
}

/** GET /api/user/tasks — one task in the account's own library. */
export interface LibraryTask {
  task_code: string;
  display_name: string;
  stored_at: string;
  last_accessed_at: string;
}

/**
 * The library's allowance. Mirrors the competition worker's quotas
 * (`routes/user-files.ts`, MAX_USER_*), which are what actually refuse an
 * upload; these only say how close the reader is.
 */
export const LIBRARY_LIMITS = {
  tracks: 500,
  tasks: 200,
  bytes: 200 * 1024 * 1024,
} as const;

export interface StorageUsage {
  usedBytes: number;
  /** The fullest of the three allowances, 0–1 (or past 1, over the limit). */
  fraction: number;
  /** "3.2 of 200 MB", with the counts only once they are within 20% of their limits. */
  summary: string;
}

/**
 * How much of the library's allowance is used. The byte allowance is the one
 * people meet in practice; the counts are high, so they are mentioned only
 * when they are near.
 */
export function storageUsage(usedBytes: number, trackCount: number, taskCount: number): StorageUsage {
  const fraction = Math.max(
    usedBytes / LIBRARY_LIMITS.bytes,
    trackCount / LIBRARY_LIMITS.tracks,
    taskCount / LIBRARY_LIMITS.tasks
  );
  const usedMB = usedBytes / (1024 * 1024);
  const limitMB = LIBRARY_LIMITS.bytes / (1024 * 1024);
  const parts = [`${usedMB < 10 ? usedMB.toFixed(1) : Math.round(usedMB)} of ${limitMB} MB`];
  if (trackCount / LIBRARY_LIMITS.tracks >= 0.8) parts.push(`${trackCount} of ${LIBRARY_LIMITS.tracks} tracks`);
  if (taskCount / LIBRARY_LIMITS.tasks >= 0.8) parts.push(`${taskCount} of ${LIBRARY_LIMITS.tasks} tasks`);
  return { usedBytes, fraction, summary: parts.join(" · ") };
}
