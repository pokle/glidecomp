/**
 * "Your track was replaced" notice — pure builder, unit-tested in
 * test/track-replaced-email.test.ts.
 *
 * Anonymous submission lets somebody who can name a pilot replace that
 * pilot's tracklog. The audit log records it publicly, but a public record
 * only works if somebody reads it, and the person with the strongest reason
 * to read it is the pilot. This email is that reading — it is the detection
 * channel for the one thing the anonymous flow gives up.
 *
 * Which is why it goes out on EVERY anonymous replacement, not only ones that
 * look suspicious. A pilot replacing their own file gets a harmless
 * confirmation; the notice is only worth anything if its absence is
 * meaningful.
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

export interface TrackReplacedEmailInput {
  to: string;
  pilotName: string;
  compName: string;
  taskName: string;
  /** How the submitter named the pilot, e.g. "CIVL ID". Never the value. */
  identifierLabel: string;
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

export function buildTrackReplacedEmail(
  input: TrackReplacedEmailInput
): EmailMessage {
  const {
    to,
    pilotName,
    compName,
    taskName,
    identifierLabel,
    taskUrl,
    organisers,
  } = input;

  const text = [
    `Hi ${pilotName},`,
    ``,
    `Your tracklog for ${taskName} at ${compName} has just been replaced by a`,
    `submission made without signing in. Whoever sent it identified you by your`,
    `${identifierLabel}.`,
    ``,
    `If that was you, there is nothing to do — the new track is the one that`,
    `will be scored.`,
    ``,
    `If it was not you, please ${organiserSentence(organisers)}.`,
    `The organiser can restore your earlier track. Every submission is recorded`,
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
    `<p>Your tracklog for <strong>${escapeHtml(taskName)}</strong> at`,
    ` <strong>${escapeHtml(compName)}</strong> has just been replaced by a submission`,
    ` made without signing in. Whoever sent it identified you by your`,
    ` ${escapeHtml(identifierLabel)}.</p>`,
    `<p>If that was you, there is nothing to do — the new track is the one that`,
    ` will be scored.</p>`,
    `<p>If it was not you, please ${organiserHtml}. The organiser can restore your`,
    ` earlier track. Every submission is recorded in the competition's public`,
    ` activity log.</p>`,
    `<p><a href="${escapeHtml(taskUrl)}">See what is on file now</a></p>`,
    `<p>— GlideComp</p>`,
  ].join("");

  return {
    to,
    from: NOTICE_FROM_ADDRESS,
    subject: `Your track for ${taskName} was replaced`,
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
export async function sendTrackReplacedNotice(
  binding: EmailSendBinding | undefined,
  message: EmailMessage
): Promise<void> {
  if (!binding) return;
  try {
    await binding.send(message);
  } catch (err) {
    console.error("track-replaced notice failed to send", err);
  }
}
