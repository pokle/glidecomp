/**
 * "Something happened to your track" notice — pure builder, unit-tested in
 * test/track-notice-email.test.ts.
 *
 * GlideComp lets people submit tracks without proving very much: anonymously
 * by naming an identifier, on behalf of a fellow pilot, or by claiming a
 * registration an organiser made. That is a deliberate choice — pilots are
 * trusted and self-service matters more than gates — and what keeps it honest
 * is that nothing happens quietly. The audit log is the public record; this
 * email is the one that reaches the person with the strongest reason to read
 * it.
 *
 * It goes out on EVERY submission, not only the ones that look suspicious. A
 * pilot filing their own track gets a harmless confirmation; the notice is
 * only worth anything if its ABSENCE is meaningful.
 *
 * Sent via the Cloudflare Email Service `send_email` binding (EMAIL in
 * wrangler.toml). Plain content only: no images, no tracking, both text and
 * HTML parts (deliverability + screen readers).
 */

/**
 * Message shape accepted by the Email Service Workers binding's send().
 *
 * Structurally identical to the one in `auth-api/src/otp-email.ts` — the two
 * workers are separate build units, and three duplicated lines beat a
 * cross-worker import.
 */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendBinding {
  send(message: EmailMessage): Promise<unknown>;
}

export const NOTICE_FROM_ADDRESS = "no-reply@glidecomp.com";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Who sent it. Shapes the sentence, and is the whole point of the notice. */
export type NoticeSubmitter =
  /** No account. `identifierLabel` is HOW they named the pilot ("CIVL ID"),
   *  never the value — the address this goes to is not proof of anything. */
  | { kind: "anonymous"; identifierLabel: string }
  /** A signed-in account. Named, because a name is what makes "was that you?"
   *  answerable without asking the organiser. */
  | { kind: "person"; name: string };

export interface TrackNoticeInput {
  to: string;
  pilotName: string;
  compName: string;
  taskName: string;
  submitter: NoticeSubmitter;
  /** True when the track REPLACED one already on file. */
  replaced: boolean;
  /** True when this submission also claimed the pilot's registration — a
   *  bigger deal than one track, because it links an account permanently. */
  claimedRegistration?: boolean;
  /** Where the pilot can look at what is now on file. */
  taskUrl: string;
  organisers: { name: string; email: string }[];
}

function organiserSentence(organisers: { name: string; email: string }[]): string {
  if (organisers.length === 0) return "contact the competition organiser";
  const parts = organisers.map((o) => `${o.name} (${o.email})`);
  if (parts.length === 1) return `contact ${parts[0]}`;
  return `contact ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

export function buildTrackNoticeEmail(input: TrackNoticeInput): EmailMessage {
  const {
    to,
    pilotName,
    compName,
    taskName,
    submitter,
    replaced,
    claimedRegistration,
    taskUrl,
    organisers,
  } = input;

  // Who, in a form a pilot can act on. An anonymous submitter cannot be named,
  // so say how they named the PILOT instead — that is the detail somebody
  // recognises ("nobody knows my SAFA number") or does not.
  const who =
    submitter.kind === "anonymous"
      ? `a submission made without signing in, identifying you by your ${submitter.identifierLabel}`
      : `${submitter.name}`;

  const what = replaced
    ? `Your tracklog for ${taskName} at ${compName} has just been replaced`
    : `A tracklog has just been filed for you on ${taskName} at ${compName}`;

  const lead =
    submitter.kind === "anonymous"
      ? `${what} by ${who}.`
      : `${what} by ${who}.`;

  const claimLine = claimedRegistration
    ? `They also linked their GlideComp account to your registration in this competition, which means their future uploads will go to it too.`
    : "";

  const consequence = replaced
    ? `If that was you, there is nothing to do — the new track is the one that will be scored.`
    : `If that was you, there is nothing to do.`;

  const text = [
    `Hi ${pilotName},`,
    ``,
    lead,
    ...(claimLine ? [``, claimLine] : []),
    ``,
    consequence,
    ``,
    `If it was not you, please ${organiserSentence(organisers)}.`,
    replaced
      ? `The organiser can restore your earlier track. Every submission is recorded`
      : `The organiser can remove it. Every submission is recorded`,
    `in the competition's public activity log.`,
    ``,
    `See what is on file now:`,
    taskUrl,
    ``,
    `— GlideComp`,
  ].join("\n");

  const organiserHtml =
    organisers.length === 0
      ? "contact the competition organiser"
      : "contact " +
        organisers
          .map(
            (o) =>
              `${escapeHtml(o.name)} (<a href="mailto:${escapeHtml(o.email)}">${escapeHtml(o.email)}</a>)`
          )
          .join(" or ");

  const html = [
    `<p>Hi ${escapeHtml(pilotName)},</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    ...(claimLine ? [`<p>${escapeHtml(claimLine)}</p>`] : []),
    `<p>${escapeHtml(consequence)}</p>`,
    `<p>If it was not you, please ${organiserHtml}.`,
    ` ${escapeHtml(
      replaced
        ? "The organiser can restore your earlier track."
        : "The organiser can remove it."
    )}`,
    ` Every submission is recorded in the competition's public activity log.</p>`,
    `<p><a href="${escapeHtml(taskUrl)}">See what is on file now</a></p>`,
    `<p>— GlideComp</p>`,
  ].join("");

  return {
    to,
    from: NOTICE_FROM_ADDRESS,
    subject: claimedRegistration
      ? `Your registration for ${compName} was claimed`
      : replaced
        ? `Your track for ${taskName} was replaced`
        : `A track was submitted for you at ${compName}`,
    text,
    html,
  };
}

/**
 * Send the notice, if this deployment can send at all.
 *
 * No-ops when the binding is absent, which is what makes local dev and the
 * worker tests work without a mail mock — the same seam auth-api uses. Never
 * throws: the upload has already succeeded by the time this runs, and a mail
 * failure must not turn that into an error the pilot sees.
 */
export async function sendTrackNotice(
  binding: EmailSendBinding | undefined,
  message: EmailMessage
): Promise<void> {
  if (!binding) return;
  try {
    await binding.send(message);
  } catch (err) {
    console.error("track notice failed to send", err);
  }
}

/**
 * Where to write to a pilot about their own track.
 *
 * Two different questions, and getting them the same way is a bug I wrote
 * once already:
 *
 * **An ordinary upload** goes to the ACCOUNT address when the registration has
 * been claimed. The registered address may be the very typo that made the
 * pilot unmatchable in the first place, and writing to it would tell a
 * stranger that Jane Smith flew task 3. The account address is one the pilot
 * demonstrably controls.
 *
 * **A CLAIM** goes to the REGISTERED address, and nowhere else. The claim has
 * just set `pilot_id` to the CLAIMER, so "prefer the account" would mail the
 * person who did it — a notice sent to its own subject is not a notice, and
 * this is the one event where being told matters most, because a wrong claim
 * links an account to somebody else's registration permanently. When the
 * organiser left no address there is genuinely nobody to tell, and the caller
 * audits that silence rather than papering over it.
 */
export function noticeAddress(
  row: {
    pilot_id: number | null;
    registered_pilot_email: string | null;
    account_email: string | null;
  },
  opts: { forClaim?: boolean } = {}
): string | null {
  if (opts.forClaim) return row.registered_pilot_email;
  if (row.pilot_id !== null && row.account_email) return row.account_email;
  return row.registered_pilot_email ?? row.account_email ?? null;
}

/**
 * Tell the registered pilot their track was submitted — on EVERY upload.
 *
 * One function because three routes need it (self, on-behalf, anonymous) and
 * the promise made on the submit form is unconditional: "we email the
 * registered pilot to tell them about it". A route that quietly skipped it
 * would make that copy a lie, and nothing in the UI would show it.
 *
 * Deliberately fire-and-forget via `waitUntil`: the upload has already
 * succeeded, and a mail failure must not turn a stored track into an error.
 *
 * Returns what to tell the client, and — when there is nobody to write to —
 * writes the audit line itself, because the log then becomes the ONLY record
 * that the notice never went out.
 */
export async function noticeOnUpload(
  ctx: {
    db: D1Database;
    email: EmailSendBinding | undefined;
    waitUntil: (p: Promise<unknown>) => void;
    origin: string;
  },
  args: {
    compId: number;
    taskId: number;
    compPilotId: number;
    taskUrl: string;
    compName: string;
    taskName: string;
    pilotName: string;
    submitter: NoticeSubmitter;
    replaced: boolean;
    claimedRegistration?: boolean;
    organisers: { name: string; email: string }[];
    /** Suppresses the mail when the address is provably the submitter's own —
     *  they are looking at the confirmation screen as it would arrive. */
    submitterEmail?: string | null;
    audit: (description: string) => Promise<void>;
  }
): Promise<{ emailed: boolean; reason?: string; masked_to?: string }> {
  const row = await ctx.db
    .prepare(
      `SELECT cp.pilot_id, cp.registered_pilot_email, u.email AS account_email
       FROM comp_pilot cp
       LEFT JOIN pilot p ON p.pilot_id = cp.pilot_id
       LEFT JOIN "user" u ON u.id = p.user_id
       WHERE cp.comp_pilot_id = ?`
    )
    .bind(args.compPilotId)
    .first<{
      pilot_id: number | null;
      registered_pilot_email: string | null;
      account_email: string | null;
    }>();

  const to = row
    ? noticeAddress(row, { forClaim: args.claimedRegistration })
    : null;
  if (!to) {
    // Nobody to write to. The upload still stands — refusing it would punish
    // exactly the pilots whose organiser did the least data entry — but the
    // audit log has to say so, because it is now the only record.
    await args.audit(
      `Could not advise ${args.pilotName} about this submission — no email address is registered for them`
    );
    return { emailed: false, reason: "no_registered_email" };
  }

  if (
    args.submitterEmail &&
    to.toLowerCase() === args.submitterEmail.toLowerCase()
  ) {
    // Writing to somebody about a thing they just did, at the address they are
    // signed in with, on the screen that already says it. Not a notice.
    return { emailed: false, reason: "submitter_is_recipient" };
  }

  ctx.waitUntil(
    sendTrackNotice(
      ctx.email,
      buildTrackNoticeEmail({
        to,
        pilotName: args.pilotName,
        compName: args.compName,
        taskName: args.taskName,
        submitter: args.submitter,
        replaced: args.replaced,
        claimedRegistration: args.claimedRegistration,
        taskUrl: args.taskUrl,
        organisers: args.organisers,
      })
    )
  );
  return { emailed: true, masked_to: maskEmailForNotice(to) };
}

/** Local copy of the mask so this module has no route-layer imports. */
function maskEmailForNotice(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
