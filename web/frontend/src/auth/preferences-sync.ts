/**
 * Cloud sync layer for user preferences and theme.
 *
 * Architecture
 * ────────────
 * - localStorage stays the synchronous read cache (no startup flicker, works
 *   offline). Cloud is the source of truth across devices when signed in.
 * - On startup we hydrate: fetch cloud, reconcile against local. Cloud wins
 *   where it has data; missing-from-cloud fields get uploaded from local
 *   (one-time migration of existing users).
 * - Mutations fire `schedulePush(kind)` from config.ts and theme.ts. Pushes
 *   are debounced 2s and PUT the *current* full localStorage value.
 * - Conflict resolution is last-write-wins. No CAS, no version field.
 *
 * Module-cycle hygiene
 * ────────────────────
 * theme.ts and config.ts statically import this module to call schedulePush.
 * This module imports them only via dynamic import() inside async paths, so
 * there's no init-time cycle.
 */

import type { AuthUser } from "./client";
import type { GlideCompTheme } from "../theme";

const STORAGE_KEY_PREFS = "glidecomp:preferences";
const STORAGE_KEY_THEME = "glidecomp:theme";
const DEBOUNCE_MS = 2000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

/**
 * Preference fields that stay device-local and never sync to cloud.
 * Stripped on upload, preserved when cloud values overwrite localStorage.
 *
 * - `mapLocation`: the user's saved viewport (zoom/pitch/bearing/centre).
 *   Different devices have different screens and use cases — what the user
 *   was looking at on their phone shouldn't dictate what their laptop opens
 *   to. Pan events also fire continuously, so syncing would generate noise.
 */
const LOCAL_ONLY_PREF_KEYS = ["mapLocation"] as const;

type Kind = "prefs" | "theme";

type CloudResponse = {
  prefs: Record<string, unknown>;
  theme: Record<string, unknown> | null;
  updated_at: string | null;
};

export class PreferencesSync {
  private user: AuthUser | null = null;
  private hydrating = false;
  private prefsTimer: ReturnType<typeof setTimeout> | null = null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pagehideHandler = () => this.flushPending();
  private readonly storageHandler = (e: StorageEvent) => {
    void this.onStorage(e);
  };

  /**
   * @param quiet  When true, skip attaching window listeners. Used for the
   *   module-level singleton in test mode so it doesn't double-handle events
   *   alongside test-instantiated copies. Production passes false.
   */
  constructor(quiet: boolean = false) {
    if (typeof window !== "undefined" && !quiet) {
      // Flush pending pushes when the page is unloading so edits made within
      // the debounce window aren't lost. keepalive: true (in put()) tells the
      // browser to commit to delivering the request even after teardown.
      window.addEventListener("pagehide", this.pagehideHandler);
      // Cross-tab sync: the browser fires `storage` on *other* tabs of the
      // same origin when localStorage changes. We use it to propagate edits
      // across same-device tabs without needing cloud round-trips. The source
      // tab never sees its own writes here (per spec).
      window.addEventListener("storage", this.storageHandler);
    }
  }

  /**
   * Detach listeners and cancel pending timers. Production never calls this
   * (the singleton lives until page unload), but tests instantiate fresh
   * instances per case and need clean teardown to avoid listener accumulation.
   */
  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.pagehideHandler);
      window.removeEventListener("storage", this.storageHandler);
    }
    if (this.prefsTimer !== null) {
      clearTimeout(this.prefsTimer);
      this.prefsTimer = null;
    }
    if (this.themeTimer !== null) {
      clearTimeout(this.themeTimer);
      this.themeTimer = null;
    }
    this.user = null;
  }

  /**
   * Another tab on the same origin wrote to localStorage. Refresh our
   * in-memory state and fire the same change event a direct mutation would
   * fire, so reactive UI updates. We deliberately do NOT trigger a cloud
   * PUT — the writing tab already scheduled one.
   */
  private async onStorage(e: StorageEvent): Promise<void> {
    // sessionStorage events also fire on this listener; ignore them.
    if (e.storageArea !== localStorage) return;

    if (e.key === STORAGE_KEY_PREFS) {
      const { config } = await import("../analysis/config");
      config.clearCache();
      window.dispatchEvent(
        new CustomEvent("glidecomp:preferences-changed", {
          detail: config.getPreferences(),
        })
      );
    } else if (e.key === STORAGE_KEY_THEME) {
      try {
        const themeMod = await import("../theme");
        // newValue is null when the other tab removed the key (resetTheme).
        // loadSavedTheme returns null in that case; fall back to the same
        // default theme.ts's autoApply uses.
        const next = themeMod.loadSavedTheme() ?? themeMod.BASECOAT_LIGHT_THEME;
        themeMod.applyTheme(next);
      } catch {
        /* malformed cloud/local theme — leave current theme applied */
      }
    }
  }

  /**
   * Reconcile local + cloud at startup. Called once after auth state is known.
   * Safe to call with null user (no-op).
   */
  async hydrate(user: AuthUser | null): Promise<void> {
    this.user = user;
    if (!user) return;

    let cloud: CloudResponse;
    try {
      const res = await fetch("/api/auth/preferences", {
        credentials: "include",
      });
      if (!res.ok) return; // 401 / 5xx — stay local-only this session
      cloud = (await res.json()) as CloudResponse;
    } catch {
      return; // network error — stay local-only
    }

    this.hydrating = true;
    try {
      await this.reconcile(cloud);
    } finally {
      this.hydrating = false;
    }
  }

  /** Schedule a debounced cloud PUT for the given storage key. */
  schedulePush(kind: Kind): void {
    if (this.hydrating || !this.user) return;
    if (kind === "prefs") {
      if (this.prefsTimer !== null) clearTimeout(this.prefsTimer);
      this.prefsTimer = setTimeout(() => {
        this.prefsTimer = null;
        void this.flushOne("prefs");
      }, DEBOUNCE_MS);
    } else {
      if (this.themeTimer !== null) clearTimeout(this.themeTimer);
      this.themeTimer = setTimeout(() => {
        this.themeTimer = null;
        void this.flushOne("theme");
      }, DEBOUNCE_MS);
    }
  }

  /** Fire any scheduled pushes immediately. Safe on unload. */
  private flushPending(): void {
    if (this.prefsTimer !== null) {
      clearTimeout(this.prefsTimer);
      this.prefsTimer = null;
      void this.flushOne("prefs");
    }
    if (this.themeTimer !== null) {
      clearTimeout(this.themeTimer);
      this.themeTimer = null;
      void this.flushOne("theme");
    }
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async reconcile(cloud: CloudResponse): Promise<void> {
    const localPrefsRaw = localStorage.getItem(STORAGE_KEY_PREFS);
    const localThemeRaw = localStorage.getItem(STORAGE_KEY_THEME);
    const localPrefs = safeParse(localPrefsRaw);
    const localTheme = safeParse(localThemeRaw);

    const cloudHasPrefs = isNonEmptyObject(cloud.prefs);
    const cloudHasTheme = cloud.theme !== null;
    const localHasPrefs = isNonEmptyObject(localPrefs);
    const localHasTheme = isNonEmptyObject(localTheme);

    // One-time upload of local-only fields: existing users keep their settings
    // when they first sign in to a cloud-synced session. LOCAL_ONLY_PREF_KEYS
    // are stripped here too so they never reach the server.
    const upload: { prefs?: unknown; theme?: unknown } = {};
    if (!cloudHasPrefs && localHasPrefs) upload.prefs = stripLocalOnly(localPrefs);
    if (!cloudHasTheme && localHasTheme) upload.theme = localTheme;
    if (upload.prefs !== undefined || upload.theme !== undefined) {
      void this.put(upload);
    }

    // Cloud wins where it has data, but we preserve LOCAL_ONLY_PREF_KEYS from
    // localStorage so per-device state (e.g. map viewport) survives hydration.
    if (cloudHasPrefs) {
      const merged = mergeLocalOnly(cloud.prefs, localPrefs);
      localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(merged));
      const { config } = await import("../analysis/config");
      // clearCache forces the next getPreferences() to re-read localStorage,
      // applying cloud values. The dispatched event lets reactive UI update.
      config.clearCache();
      window.dispatchEvent(
        new CustomEvent("glidecomp:preferences-changed", {
          detail: config.getPreferences(),
        })
      );
    }
    if (cloudHasTheme && cloud.theme) {
      localStorage.setItem(STORAGE_KEY_THEME, JSON.stringify(cloud.theme));
      // Theme shape is owned by the client; server stores opaque JSON. If a
      // future schema change makes the cloud value invalid, swallow the
      // error rather than crashing the page — localStorage still holds the
      // saved theme; the user can clear it via the editor.
      try {
        const { applyTheme } = await import("../theme");
        applyTheme(cloud.theme as unknown as GlideCompTheme);
      } catch {
        /* malformed cloud theme — leave the current applied theme in place */
      }
    }
  }

  private async flushOne(kind: Kind): Promise<void> {
    if (kind === "prefs") {
      const raw = localStorage.getItem(STORAGE_KEY_PREFS);
      if (!raw) return;
      const parsed = safeParse(raw);
      if (!isNonEmptyObject(parsed)) return;
      const stripped = stripLocalOnly(parsed);
      // Don't bother PUTting if the only changed field was local-only
      // (e.g. map pan). The stripped object may be empty.
      if (Object.keys(stripped).length === 0) return;
      await this.put({ prefs: stripped });
    } else {
      const raw = localStorage.getItem(STORAGE_KEY_THEME);
      // theme can legitimately be null (user reset), and we want to tell the
      // server about that — that's why a missing-from-localStorage theme
      // PUTs theme=null rather than skipping.
      const parsed = raw ? safeParse(raw) : null;
      await this.put({ theme: parsed });
    }
  }

  private async put(body: object, attempt: number = 0): Promise<void> {
    let res: Response;
    try {
      res = await fetch("/api/auth/preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch {
      if (attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** attempt);
        return this.put(body, attempt + 1);
      }
      return;
    }
    if (res.status === 401) {
      // Session expired — stop syncing. localStorage already has the write.
      this.user = null;
      return;
    }
    // 4xx is permanent (validation, auth, payload too large). Retrying the
    // same body won't change the outcome and would waste cycles. Only retry
    // network errors (handled in the catch above) and 5xx.
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await delay(BACKOFF_BASE_MS * 2 ** attempt);
      return this.put(body, attempt + 1);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stripLocalOnly(
  prefs: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prefs };
  for (const k of LOCAL_ONLY_PREF_KEYS) delete out[k];
  return out;
}

function mergeLocalOnly(
  cloudPrefs: Record<string, unknown>,
  localPrefs: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cloudPrefs };
  if (!isNonEmptyObject(localPrefs)) return out;
  for (const k of LOCAL_ONLY_PREF_KEYS) {
    if (localPrefs[k] !== undefined) out[k] = localPrefs[k];
  }
  return out;
}

function safeParse(s: string | null): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length > 0
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// In test mode the singleton stays inert (no listeners, no bootstrap) so it
// doesn't shadow test-instantiated copies. Tests construct fresh
// `new PreferencesSync()` for the cases that need active listeners.
export const preferencesSync = new PreferencesSync(
  import.meta.env.MODE === "test"
);

// ── auto-bootstrap on import ─────────────────────────────────────────────────
// Mirrors theme.ts's autoApply pattern. Any page that imports this module
// (directly or transitively via theme.ts/config.ts) gets hydration.
//
// After preferences hydrate, we also run the one-time IndexedDB → R2/D1
// migration for tracks and tasks. Both are signed-in-only.
//
// Skipped under vitest (MODE === 'test') so tests get a quiet module — they
// instantiate PreferencesSync directly with mocked fetch.
async function bootstrap(): Promise<void> {
  const { getCurrentUser } = await import("./client");
  const user = await getCurrentUser();
  await preferencesSync.hydrate(user);
  if (user) {
    const { runUserFilesMigration } = await import("./user-files-migration");
    void runUserFilesMigration();
  }
}
if (import.meta.env.MODE !== "test") {
  void bootstrap();
}
