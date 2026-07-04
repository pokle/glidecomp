# Security principle: encode on output, validate on input — don't sanitise on input

> **TL;DR** Store user-entered values raw. Prevent XSS by **encoding at the point
> of use** (output encoding), where the correct encoding depends on the context
> (HTML text, HTML attribute, URL, CSV, JSON, …). Do **not** HTML-encode values
> when they are first written to the database — it corrupts every non-HTML
> consumer of that data and still doesn't remove the need to encode on output.
> Server-side *validation* (reject control characters, bound length) is a
> worthwhile complement, but it is not a substitute for output encoding.

This note exists because it's a recurring question during security reviews (see
`docs/security-review.md`, SEC-05 and SEC-22): *"if a value can cause XSS, why
don't we just sanitise it once on the server when the user submits it?"* The
short answer is that HTML-sanitising on input is an anti-pattern for values that
are stored and later rendered in more than one context — which is almost all of
GlideComp's user-entered text.

## The two strategies

**Output encoding (what we do, and should keep doing).** The value is stored
exactly as the user typed it. Each time it is placed into an output, it is
encoded for *that output's* grammar:

| Context | Encoding | Example helper |
|---|---|---|
| HTML text (`>…<`) | escape `& < >` | `escapeHtml` |
| HTML attribute (`title="…"`) | escape `& < > " '` | `escapeHtml` (quote-safe) |
| URL path/query segment | percent-encode | `encodeURIComponent` |
| CSV cell | quote + double the quotes | `csvEscape` |
| JSON | `JSON.stringify` | — |
| DOM (preferred) | assign to `.textContent` / build with `createElement` | — |

The safest form is not to build HTML strings at all: set `.textContent` or build
nodes with `createElement`, which makes injection structurally impossible. The
`scores.ts` refactor and much of `comp-detail.ts` already do this.

**Input HTML-sanitisation (what we avoid).** The value is transformed *once* on
write — e.g. `<` becomes `&lt;`, or tags are stripped — and the mangled version
is stored. This is the tempting "just fix it at the source" approach, and it is
the wrong layer for stored, reused data.

## Why input HTML-sanitisation is the wrong choice here

The value lives in D1 and is consumed in many contexts. HTML-encoding it on the
way in optimises for exactly one of them (HTML) and breaks the rest:

1. **It corrupts non-HTML consumers.** A pilot named `O'Brien` stored as
   `O&#39;Brien` shows up literally wrong in:
   - **CSV export** (the pilots section exports the roster) — spreadsheets don't
     decode HTML entities.
   - **The audit log** — descriptions like `Registered pilot "O&#39;Brien"`
     (`pilot.ts`), which are the public transparency record per `CLAUDE.md`.
   - **API responses** — names are returned as JSON to the browser today and to
     any future native/mobile client or server-rendered PDF results sheet.
   - **Sorting and matching** — `registered_pilot_name COLLATE NOCASE` ordering
     and the pilot-account link-matching logic operate on the stored bytes.

2. **It doesn't let you drop output encoding.** Other fields, other sinks, and
   any value that *wasn't* sanitised on input still have to be encoded at render
   time. So input sanitisation doesn't remove the real defence — it adds a
   second, lossy transform on top of it.

3. **It causes double-encoding.** If a value is HTML-encoded on input *and*
   escaped on output (because the render site correctly escapes, not trusting
   its input), `<` becomes `&amp;lt;` and the user sees `&lt;` on screen.

4. **The correct encoding isn't knowable at write time.** The server storing the
   name has no idea whether it will later land in an HTML attribute, a URL, a CSV
   cell, or a JSON body. Only the render site knows its own context.

## "But the engine's `sanitizeText` HTML-encodes on parse — isn't that the same?"

`web/engine/src/sanitize.ts` HTML-encodes IGC/XCTSK values at parse time, and the
security review has praised it. It is a deliberately **contained special case**,
not a model to copy to database fields:

- Those values come out of an opaque file-parser that is reused across many call
  sites; encoding once at the parse boundary is a pragmatic belt-and-braces for a
  widely-shared parser.
- They are **not** round-tripped through CSV export, the audit log, or the public
  API the way `registered_pilot_name` / `team_name` / `pilot_class` are.

Even for the engine, output encoding at each sink is what actually prevents the
XSS; `sanitizeText` is the second layer, not the first. That is exactly why
SEC-22 was still exploitable in comp mode: the display name there comes from the
**database** (`registered_pilot_name`), which never passes through `sanitizeText`
— only IGC-header names do.

## Where server-side input handling *does* help (validation, not sanitisation)

Validation rejects or normalises clearly-bad input without corrupting legitimate
values. It is cheap defence-in-depth and complements — never replaces — output
encoding:

- **Bound length** (already done: `z.string().min(1).max(128)`).
- **Reject control characters** and normalise Unicode on user text fields.
- Optionally **reject** (HTTP 400) — not silently strip — a literal `<` or `>` in
  name-type fields. Real names never contain them, so this shrinks the attack
  surface without mangling `O'Brien` or `Müller`. Note that `"`, `'`, and `&` are
  legitimate in names and teams and must still pass through, so **output encoding
  remains mandatory regardless.**

If such rejection is added, it must be audit-logged like any other mutation
outcome and surfaced to the user as a clear validation error, not a silent edit
of their data.

## The actual fix for the XSS class

The root cause of SEC-22 was not "missing input sanitisation" — it was that the
frontend had seven hand-rolled `escapeHtml` copies applied by per-author
discipline, so any new sink that forgot to call one was vulnerable (this is
SEC-05). The structural close-out is:

1. One shared, quote-safe output encoder — `web/frontend/src/escape-html.ts`
   (introduced with the SEC-22 fix) — used everywhere.
2. Prefer `.textContent` / DOM construction over building HTML strings.
3. A lint rule forbidding `innerHTML =` with interpolated non-constant template
   literals, to make the safe path the default.

Input validation trims the edges of the attack surface; consistent output
encoding removes the bug class.

## Rules of thumb

- **Store what the user typed.** Don't transform-on-write for display safety.
- **Encode at every output, for that output's context.** Never trust that a value
  was "already cleaned."
- **Prefer DOM APIs** (`textContent`, `createElement`) over HTML string building.
- **Validate on input to reject the obviously-hostile** (control chars, absurd
  length, tags in name fields) — as a complement, never as the primary defence.
- **Never double-encode:** exactly one encoding step, at the output.
