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
| HTML text (`>…<`) | set as a text node | `html\`…${v}…\`` (lit-html, `web/frontend/src/render-html.ts`); JSX |
| HTML attribute (`title="…"`) | set as an attribute value | the same template bindings; JSX |
| HTML built as a string (SSR Function, emails) | escape `& < > " '` | the module's own escaper, e.g. `track-notice-email.ts` |
| URL path/query segment | percent-encode | `encodeURIComponent` |
| CSV cell | quote + double the quotes | `csvEscape` |
| JSON | `JSON.stringify` | — |
| DOM (preferred) | assign to `.textContent` / build with `createElement` | — |

The safest form is not to build HTML strings at all: set `.textContent` or build
nodes with `createElement`, which makes injection structurally impossible. The
React pages get this by default — JSX text children are escaped — and since
2026-10 so do the vanilla analysis page and 3D replay, whose lit-html templates
set every interpolated value on a DOM node rather than parsing it. The
string-encoding helpers are for what still writes markup or files by hand (the
SSR Function, emails, CSV exports).

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

## "Didn't the engine HTML-encode names on parse?"

It did, until 2026-10. `sanitizeText()` stripped tag-shaped runs from every
IGC and XCTask name and HTML-encoded `& < > " '` at parse time, on the theory
that a widely-shared parser should hand out values safe to drop into HTML. It
was the anti-pattern this note describes, and it failed the same ways:

- **It corrupted the non-HTML consumers.** React encodes on output, so a pilot
  called O'Brien read `O&#39;Brien`. A route imported from an `.xctsk` stored
  the entities in its turnpoint names, and the personal library stored them in
  track names.
- **It double-encoded** wherever a page also (correctly) escaped on output — the
  analysis page showed `&amp;`.
- **It never was the defence.** SEC-22 was exploitable in comp mode because the
  name there came from the database (`registered_pilot_name`), which never
  passed through the parser.

The parsers now return text as the file wrote it (`web/engine/src/text.ts`,
`toText()`, which only coerces a non-string field so a malformed file cannot
crash its caller). Scoring change 053 records it, and migration 0035 decoded the
names already stored encoded. A competition route imported from a file before
then may still carry an `&amp;` in a turnpoint name; that is stored route data,
so it is renamed by the organiser rather than rewritten by a migration.

## Where server-side input handling *does* help (validation, not sanitisation)

Validation rejects or normalises clearly-bad input without corrupting legitimate
values. It is cheap defence-in-depth and complements — never replaces — output
encoding. All of it is **implemented** (issue #232), in
`web/workers/competition-api/src/validators.ts`, as three schema builders every
user-entered comp text field is built from:

| Builder | Used for | Rejects | Normalises |
|---|---|---|---|
| `nameText` | pilot / team / class / comp / task names, gliders, sporting-body IDs | control characters, `<`, `>` | NFC |
| `plainText` | phones, driver contact, penalty reason, status notes, close date | control characters | NFC |
| `proseText` | task weather notes | control characters except tab / LF / CR | NFC |

- **Bound length** (`z.string().min(1).max(128)`) — unchanged; the builders wrap
  the existing bounded string rather than replacing it.
- **Control characters** (Unicode category Cc — C0, DEL and C1, the same set
  the waypoints route's `\p{Cc}` check uses) are rejected everywhere. They are never
  legitimate in these fields, and a raw line break is how one CSV row or one
  audit-log line becomes two.
- A literal `<` or `>` in a **name-type** field is **rejected** (HTTP 400), never
  silently stripped. Real names never contain them, so this shrinks the attack
  surface without mangling `O'Brien` or `Müller`. `driver_contact` is
  deliberately *not* a name field — `Jo <jo@example.com>` is a real way to write
  a contact — which is a good illustration of why the rule cannot be applied
  blindly to every string.
- `"`, `'`, and `&` are legitimate in names and teams and still pass through, so
  **output encoding remains mandatory regardless.**
- **NFC normalisation** is the one transform, and it is canonical equivalence —
  the same text in its canonical form — so `Müller` typed as U+00FC and as
  U+0075 U+0308 sort, dedupe and link-match as one name.

A rejection surfaces to the user as a clear validation error naming the field —
`validated()` prefixes the zod path, so a bulk roster save answers
`pilots.3.registered_pilot_name: must not contain < or >` and the grid can point
at the row. It is not audit-logged, because nothing is written: a rejected
request never reaches the handler that would have logged it. Coverage:
`web/workers/competition-api/test/user-text-validation.test.ts`.

## The actual fix for the XSS class

The root cause of SEC-22 was not "missing input sanitisation" — it was that the
frontend had seven hand-rolled `escapeHtml` copies applied by per-author
discipline, so any new sink that forgot to call one was vulnerable (this is
SEC-05). Consolidating them into one shared encoder (`escape-html.ts`, with the
SEC-22 fix) did not end it: SEC-41 found eight more sites that forgot to call
it, and SEC-47 a ninth. Opt-in escaping keeps failing however good the
encoder is. The close-out (security review proposal A4, 2026-10) removes the
choice:

1. **No string reaches a DOM sink.** The analysis page and replay render
   through lit-html templates (`web/frontend/src/render-html.ts`); a value
   interpolated into one becomes a text node or an attribute value, in any
   position, with nothing to remember. `escape-html.ts` is deleted — there is
   nothing left to call it.
2. **A test instead of a lint rule** — `web/frontend/src/html-sinks.test.ts`
   fails on any `innerHTML`-style sink, `insertAdjacentHTML`, `DOMParser`,
   Mapbox's `setHTML`, or lit's `unsafeHTML` escape hatch anywhere in
   `web/frontend/src/`.
3. **Trusted Types in the browser** — the same rule enforced at runtime, so it
   also covers code we didn't write. `security-headers.ts` ships it
   report-only on `/analysis` and `/replay` for now; the `default` policy in
   `trusted-types.ts` sanitises third-party HTML (Mapbox's attribution) with
   DOMPurify and refuses foreign script URLs.

With every sink encoding on output, the engine's parse-time encoding had
nothing left to protect and was removed too (see above).

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
