import type { AuthUser } from "./env";

/**
 * Hardcoded super-admin allowlist. Every listed account is treated as an
 * admin of *every* competition — the per-comp `comp_admin` table is not
 * consulted for them.
 *
 * This is intentionally a small compiled-in list rather than a DB table or
 * env var: super-admin is a privileged, rarely-changing capability and
 * keeping it in source keeps it reviewable in git history. Emails are matched
 * case-insensitively (see `isSuperAdmin`).
 */
export const SUPER_ADMIN_EMAILS: readonly string[] = ["tushar.pokle@gmail.com"];

/** True if the user is on the hardcoded super-admin allowlist. */
export function isSuperAdmin(
  user: Pick<AuthUser, "email"> | null | undefined
): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email);
}

/**
 * True if the user may administer the given competition: either a hardcoded
 * super admin (all comps) or the holder of a `comp_admin` row for this comp.
 *
 * This is the single source of truth for comp-admin authorization. Every
 * route that gates on admin access should call this rather than querying
 * `comp_admin` directly, so the super-admin bypass applies uniformly.
 */
export async function isCompAdmin(
  db: D1Database,
  compId: number,
  user: Pick<AuthUser, "id" | "email"> | null | undefined
): Promise<boolean> {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  const row = await db
    .prepare("SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?")
    .bind(compId, user.id)
    .first();
  return !!row;
}
