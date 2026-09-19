/**
 * Frontend mirror of the competition-api super-admin allowlist
 * (`web/workers/competition-api/src/super-admin.ts`). Kept in sync by hand —
 * the list is intentionally tiny and reviewable.
 *
 * Used to keep site super admins out of "organised by" credit: they can
 * administer every competition, but they do not organise one unless they are
 * also a real `comp_admin` — and even then the credit line should name the
 * competition's organisers, not the platform operator.
 */
export const SUPER_ADMIN_EMAILS: readonly string[] = ["tushar.pokle@gmail.com"];

/** True when the address is on the hardcoded super-admin allowlist. */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  const normalised = email?.trim().toLowerCase();
  if (!normalised) return false;
  return (SUPER_ADMIN_EMAILS as readonly string[]).includes(normalised);
}
