/**
 * The page a competition's own text is spliced into must come out holding
 * exactly that text. `String.replace` reads `$&`, `$'`, `` $` `` and `$$` in a
 * replacement STRING as patterns, and everything spliced here is user text:
 * a pilot's name, an organiser's notes, a task's name.
 */
import { describe, expect, it } from "vitest";
import { injectSsr, serialize } from "./ssr-inject";

const TEMPLATE =
  '<!doctype html><html><head><title>GlideComp</title></head>' +
  '<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

const HEAD = { title: "Corryong Cup", description: "Scores", extra: "" };

/** Every `$` sequence a replacement string would have rewritten. */
const DOLLARS = "Prize $$$, $& and $' and $` and $1";

function page(bodyHtml: string, data: unknown, head = HEAD): Document {
  const html = injectSsr(TEMPLATE, "/comp/x", bodyHtml, head, { path: "/comp/x", data });
  return new DOMParser().parseFromString(html, "text/html");
}

describe("injectSsr", () => {
  it("puts the markup in #root and the data in its block", () => {
    const doc = page("<p>Hello</p>", { name: "Corryong Cup" });
    expect(doc.querySelector("#root")!.innerHTML).toBe("<p>Hello</p>");
    expect(JSON.parse(doc.getElementById("__SSR_DATA__")!.textContent!)).toEqual({
      path: "/comp/x",
      data: { name: "Corryong Cup" },
    });
    expect(doc.title).toBe("Corryong Cup");
    expect(doc.querySelectorAll("title")).toHaveLength(1);
  });

  it("keeps dollar signs in the rendered markup as they were written", () => {
    // What React renders for a pilot called `Jo "$" Blow`: `$&quot;`.
    const body = `<p>Jo &quot;$&quot; Blow — ${DOLLARS.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}</p>`;
    const doc = page(body, {});
    expect(doc.querySelector("#root")!.innerHTML).toBe(
      new DOMParser().parseFromString(body, "text/html").body.innerHTML
    );
    expect(doc.querySelectorAll('[id="root"]')).toHaveLength(1);
    expect(doc.querySelectorAll('script[type="module"]')).toHaveLength(1);
  });

  it("keeps dollar signs in the data block, which stays one block of JSON", () => {
    const data = { notes: DOLLARS, name: "A$$AP" };
    const doc = page("<p>x</p>", data);
    const block = doc.getElementById("__SSR_DATA__")!;
    expect(JSON.parse(block.textContent!).data).toEqual(data);
    // Nothing of the JSON spilled out of the block and onto the page.
    const visible = doc.body.cloneNode(true) as HTMLElement;
    for (const script of visible.querySelectorAll("script")) script.remove();
    expect(visible.textContent).toBe("x");
    expect(doc.querySelectorAll('script[type="module"]')).toHaveLength(1);
  });

  it("keeps dollar signs in the title and description", () => {
    const doc = page("<p>x</p>", {}, { title: DOLLARS, description: DOLLARS, extra: "" });
    expect(doc.title).toBe(DOLLARS);
    expect(doc.querySelector('meta[name="description"]')!.getAttribute("content")).toBe(DOLLARS);
    expect(doc.querySelectorAll("head").length).toBe(1);
    expect(doc.querySelector("#root")!.innerHTML).toBe("<p>x</p>");
  });
});

describe("serialize", () => {
  it("cannot end the script block it is written into", () => {
    const out = serialize({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("<");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });
});
