/**
 * Plain text with its web addresses made clickable (lib/linkify.ts decides
 * which). Every part is a React text node, so nothing in the text can become
 * markup; a link's text is the address itself.
 *
 * Links open in a new tab. `noopener noreferrer` keeps the other page from
 * reaching back into this tab and from learning which comp sent the reader;
 * `nofollow ugc` marks them as user-written for search engines, so a public
 * comp page is no use for planting links.
 */
import { linkify } from "../lib/linkify";

export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.kind === "link" ? (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="wrap-anywhere underline underline-offset-2"
          >
            {part.text}
          </a>
        ) : (
          part.text
        )
      )}
    </>
  );
}
