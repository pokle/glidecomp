/**
 * The discovery files, each held to the spec it claims to follow (docs/mcp.md):
 *
 * - the MCP Server Card mcp-api serves at /mcp/server-card — SEP-2127, the
 *   `io.modelcontextprotocol/server-card` extension, validated against its own
 *   JSON Schema;
 * - /.well-known/ard.json — Agentic Resource Discovery v0.91, validated against
 *   ARD's schema;
 * - /.well-known/ai-catalog.json — the AI Catalog spec (Agent-Card/ai-catalog),
 *   which publishes no JSON Schema, so its rules are checked as written;
 * - /llms.txt — the llmstxt.org format.
 *
 * The two schemas are vendored in ./fixtures so the check runs offline:
 *   server-card.schema.json  github.com/modelcontextprotocol/ext-server-card  schema.json
 *   ard-entry.schema.json    github.com/ards-project/ard-spec  spec/schemas/ard-entry.schema.json
 * (both fetched 2026-10-25). Refresh them when either spec moves; the
 * card's `$schema` URL is an identifier the schema pattern-matches, not a
 * document — static.modelcontextprotocol.io serves nothing there.
 */
import { describe, expect, test } from "bun:test";
import { Validator } from "@cfworker/json-schema";
import { cardFor } from "../src/server-card";

const PUBLIC = new URL("../../../frontend/public/", import.meta.url);
const read = (path: string, base: URL = PUBLIC) => Bun.file(new URL(path, base)).text();
const json = async (path: string, base?: URL) => JSON.parse(await read(path, base)) as any;
const fixture = (name: string) => json(name, new URL("./fixtures/", import.meta.url));

/** A validator for one `$defs` member of a 2020-12 schema document. */
async function validatorFor(file: string, def: string) {
  const schema = await fixture(file);
  return new Validator({ ...schema, $ref: `#/$defs/${def}` }, "2020-12", false);
}

const PROD = "https://glidecomp.com";
const CARD_URL = `${PROD}/mcp/server-card`;

describe("the MCP Server Card", () => {
  test("validates against the extension's schema, in production and in dev", async () => {
    const v = await validatorFor("server-card.schema.json", "ServerCard");
    for (const origin of [PROD, "http://localhost:3000"]) {
      const r = v.validate(cardFor(origin));
      expect(r.errors, origin).toEqual([]);
    }
  });

  test("the validator bites: a card with no name is refused", async () => {
    const v = await validatorFor("server-card.schema.json", "ServerCard");
    const { name: _name, ...nameless } = cardFor(PROD);
    expect(v.validate(nameless).valid).toBe(false);
  });

  test("lives at the reserved <streamable-http-url>/server-card", () => {
    expect(`${cardFor(PROD).remotes[0]!.url}/server-card`).toBe(CARD_URL);
  });
});

describe("/.well-known/ard.json (ARD v0.91)", () => {
  test("validates against ARD's manifest schema", async () => {
    const v = await validatorFor("ard-entry.schema.json", "ArdManifest");
    const r = v.validate(await json(".well-known/ard.json"));
    expect(r.errors).toEqual([]);
  });

  test("lists the card, with the 2–5 representative queries ARD asks for", async () => {
    const { entries } = await json(".well-known/ard.json");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      identifier: "urn:air:glidecomp.com:mcp:glidecomp",
      displayName: "GlideComp",
      type: "application/mcp-server-card+json",
      url: CARD_URL,
    });
    expect(entries[0].representativeQueries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].representativeQueries.length).toBeLessThanOrEqual(5);
  });
});

describe("/.well-known/ai-catalog.json (AI Catalog 1.0)", () => {
  test("has the members the spec requires, and points at the same card", async () => {
    const catalog = await json(".well-known/ai-catalog.json");
    expect(catalog.specVersion).toMatch(/^1\.\d+$/);
    expect(Array.isArray(catalog.entries)).toBe(true);
    for (const entry of catalog.entries) {
      expect(typeof entry.identifier).toBe("string");
      expect(typeof entry.type).toBe("string");
      // Exactly one of url or data.
      expect(("url" in entry) !== ("data" in entry)).toBe(true);
    }
    const ard = await json(".well-known/ard.json");
    const pick = ({ identifier, type, url }: Record<string, string>) => ({ identifier, type, url });
    expect(catalog.entries.map(pick)).toEqual(ard.entries.map(pick));
  });
});

describe("every discovery file", () => {
  // Read by programs that may not decode UTF-8 kindly, and nothing in them
  // needs more than ASCII: a stray em dash or curly quote is a typo here.
  test("is plain ASCII", async () => {
    const files = {
      "llms.txt": await read("llms.txt"),
      "ard.json": await read(".well-known/ard.json"),
      "ai-catalog.json": await read(".well-known/ai-catalog.json"),
      "server card": JSON.stringify(cardFor(PROD)),
    };
    for (const [name, text] of Object.entries(files)) {
      const stray = [...text].filter((c) => c.charCodeAt(0) > 0x7f);
      expect(stray, name).toEqual([]);
    }
  });
});

describe("/llms.txt (llmstxt.org)", () => {
  test("an H1, a summary blockquote, prose without headings, then sections of link lists", async () => {
    const lines = (await read("llms.txt")).split("\n");
    expect(lines[0]).toMatch(/^# \S/);
    const body = lines.slice(1);
    expect(body.find((l) => l.trim() !== "")).toMatch(/^> \S/);
    // No heading but H2s after the H1, and no H1 again.
    expect(body.filter((l) => /^#/.test(l)).every((l) => /^## \S/.test(l))).toBe(true);
    // Inside an H2 section, every list item leads with a markdown link.
    const firstH2 = body.findIndex((l) => l.startsWith("## "));
    expect(firstH2).toBeGreaterThan(0);
    for (const line of body.slice(firstH2).filter((l) => l.trim() !== "" && !l.startsWith("## "))) {
      expect(line).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)]+\)/);
    }
  });

  test("names the MCP endpoint before anything else", async () => {
    const text = await read("llms.txt");
    const firstH2 = text.indexOf("\n## ");
    expect(text.slice(0, firstH2)).toContain("https://glidecomp.com/mcp");
  });
});
