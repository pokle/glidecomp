/**
 * Sign-in OTP email — pure builder, unit-tested in test/otp-email.test.ts.
 *
 * Sent via the Cloudflare Email Service `send_email` binding (EMAIL in
 * wrangler.toml). Plain content only: no images, no tracking, both text and
 * HTML parts (deliverability + screen readers).
 */

/** Message shape accepted by the Email Service Workers binding's send(). */
export interface OtpEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** Minimal structural type for the binding itself (workers-types doesn't
 * ship one for the Email Service send API yet). */
export interface EmailSendBinding {
  send(message: OtpEmailMessage): Promise<unknown>;
}

export const OTP_FROM_ADDRESS = "no-reply@glidecomp.com";

/** Must match the emailOTP plugin's expiresIn in auth.ts (600s). */
export const OTP_EXPIRY_MINUTES = 10;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The deep link carries the code in the URL *fragment*, never the query
 * string — fragments are not sent to the server, so the code stays out of
 * Cloudflare access logs. The SPA's /signin page reads and strips the hash.
 *
 * `baseURL` is BETTER_AUTH_URL, i.e. the production origin — same rule as
 * the oAuthProxy: emailed links always land on prod, even when the code was
 * requested from a branch preview (where the user can still type the code).
 */
export function buildOtpSignInUrl(
  baseURL: string,
  email: string,
  otp: string
): string {
  const origin = baseURL.replace(/\/+$/, "");
  return `${origin}/signin#otp=${encodeURIComponent(otp)}&email=${encodeURIComponent(email)}`;
}

export function buildOtpEmail(opts: {
  email: string;
  otp: string;
  baseURL: string;
}): OtpEmailMessage {
  const { email, otp, baseURL } = opts;
  const url = buildOtpSignInUrl(baseURL, email, otp);

  const text = [
    `Your GlideComp sign-in code is:`,
    ``,
    `    ${otp}`,
    ``,
    `Or click to sign in directly:`,
    url,
    ``,
    `This code expires in ${OTP_EXPIRY_MINUTES} minutes and can be used once.`,
    `If you didn't request it, you can ignore this email — no one can sign in`,
    `without this code.`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f6f6f6;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
  <div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
    <p style="margin:0 0 8px;font-size:16px;">Your GlideComp sign-in code is:</p>
    <p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(otp)}</p>
    <p style="margin:0 0 24px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;">Sign in to GlideComp</a>
    </p>
    <p style="margin:0;font-size:13px;color:#555555;">
      This code expires in ${OTP_EXPIRY_MINUTES} minutes and can be used once.
      If you didn't request it, you can ignore this email &mdash; no one can
      sign in without this code.
    </p>
  </div>
</body>
</html>`;

  return {
    to: email,
    from: OTP_FROM_ADDRESS,
    subject: `Your GlideComp sign-in code: ${otp}`,
    text,
    html,
  };
}
