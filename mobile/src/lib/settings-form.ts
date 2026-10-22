/** Small checks the settings forms make before a write, so a refusal is said before it is sent. */

/** An IANA zone the runtime knows ("Australia/Melbourne"); Hermes supports Intl's zone list. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** "a@x.com, b@y.org" → the addresses, or the first that is not one. */
export function parseEmails(text: string): { emails: string[]; bad: string | null } {
  const emails = text
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) ?? null;
  return { emails: [...new Set(emails.map((e) => e.toLowerCase()))], bad };
}
