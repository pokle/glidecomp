import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "fs";
import { gzipSync } from "zlib";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { API_KEY_RATE_LIMIT } from "../web/workers/auth-api/src/rate-limit";

// ── What this guards ─────────────────────────────────────────────────────────
// docs/api.md is hand-written, but every curl example in it is *executed* here
// against the live local stack. If an endpoint is renamed, an auth rule
// changes, or a method changes and the doc isn't updated, the extracted command
// stops returning 2xx and this test goes red. The doc stays the source of truth;
// this test stops it from rotting. See the PR discussion for the "1½" approach.

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DOC = resolve(__dirname, "..", "docs/api.md");
const SAMPLE_IGC = resolve(
  __dirname,
  "..",
  "web/samples/comps/corryong-cup-2026-open-t1/lamb_18239_050126.igc"
);
const SAMPLE_XCTSK = resolve(
  __dirname,
  "..",
  "web/samples/comps/corryong-cup-2026-open-t1/task.xctsk"
);

// Placeholder IDs the doc uses in its example URLs / key header.
const PLACEHOLDER = {
  comp: "Ux7Kp2",
  task: "9fBqLm",
  pilot: "PILOT_ID",
  key: "glc_XXXXXXXX...",
  host: "https://glidecomp.com",
  igcFile: "flight.igc",
};

interface DocCall {
  method: string;
  /** Substituted path, e.g. "/api/comp/AbC/task/DeF/score" */
  path: string;
  headers: Record<string, string>;
  gzipBody: boolean;
  raw: string;
}

/** Shell-ish tokenizer: splits on whitespace, honours single/double quotes. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

/** Pull every ```bash fenced block that contains a curl invocation. */
function extractCurlBlocks(md: string): string[] {
  const blocks: string[] = [];
  const fence = /```bash\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md)) !== null) {
    if (m[1].includes("curl")) blocks.push(m[1].trim());
  }
  return blocks;
}

/**
 * Parse one bash block into a request. Handles the two shapes the doc uses:
 *   curl [-X M] [-H "k: v"]... URL
 *   gzip -c flight.igc | curl -X POST ... --data-binary @- URL
 * `subst` maps placeholder IDs → the real seeded values (pilot id is filled in
 * once the self-upload block reveals it, so it's read lazily at parse time).
 */
function parseBlock(raw: string, subst: () => Record<string, string>): DocCall {
  // Join line-continuations, then take the curl side of any gzip pipe.
  const joined = raw.replace(/\\\n/g, " ").replace(/\n/g, " ");
  const gzipBody = /gzip\s+-c/.test(joined) && joined.includes("--data-binary");
  const curlPart = joined.includes("|") ? joined.split("|").pop()! : joined;
  const tokens = tokenize(curlPart);

  let method: string | null = null;
  let url: string | null = null;
  const headers: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-X" || t === "--request") {
      method = tokens[++i];
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i];
      const idx = h.indexOf(":");
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else if (t === "--data-binary" || t === "-d" || t === "--data") {
      i++; // consume the value (@- — body comes from the gzip pipe)
    } else if (t.startsWith("http")) {
      url = t;
    }
    // Bare flags like -OJ (download to file) are ignored — they don't change
    // the request the server sees.
  }

  if (!url) throw new Error(`No URL found in doc block:\n${raw}`);
  method = method ?? (gzipBody ? "POST" : "GET");

  const map = subst();
  const apply = (s: string): string => {
    let out = s.replace(PLACEHOLDER.host, "");
    for (const [ph, real] of Object.entries(map)) out = out.split(ph).join(real);
    return out;
  };

  const path = apply(url);
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) outHeaders[k] = apply(v);

  return { method, path, headers: outHeaders, gzipBody, raw };
}

/** Dev-login on this context; its cookie jar keeps the session for later calls. */
async function devLogin(ctx: APIRequestContext): Promise<string> {
  const suffix = String(Date.now()).slice(-6) + Math.floor(Math.random() * 100);
  const res = await ctx.post("/api/auth/dev-login", {
    data: { name: "API Doc Bot", email: `api-doc-${suffix}@test.local` },
  });
  if (!res.ok()) {
    throw new Error(`dev-login failed: ${res.status()} ${await res.text()}`);
  }
  const setCookie = res.headers()["set-cookie"];
  const match = setCookie?.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("dev-login response missing session cookie");
  return `better-auth.session_token=${match[1]}`;
}

test("every curl example in docs/api.md works against the live API", async ({
  playwright,
  baseURL,
}) => {
  const md = readFileSync(API_DOC, "utf8");

  // ── Rate-limit pin ─────────────────────────────────────────────────────────
  // The doc quotes the limit; assert it matches the constant the worker
  // actually enforces (web/workers/auth-api/src/rate-limit.ts), so a config
  // bump forces a doc update.
  const stated = `${API_KEY_RATE_LIMIT.maxRequests} requests per ${
    API_KEY_RATE_LIMIT.timeWindowMs / 1000
  } seconds`;
  expect(
    md,
    `docs/api.md must state the enforced rate limit ("${stated}")`
  ).toContain(stated);

  // ── Seed: a public comp with a scorable task, owned by the API-key user ─────
  // Auth is fiddly to drive from an API client. We grab the session cookie from
  // a throwaway login context and send it as an explicit header (with a same-
  // site Origin, which Better Auth's plugin routes require) — mirroring curl,
  // which does this 100% reliably. Each Better Auth POST gets its OWN fresh
  // context: the local `wrangler pages dev` proxy intermittently mishandles
  // Playwright's pooled keep-alive connections on stateful auth POSTs, so a
  // fresh connection pool per call avoids the spurious 401.
  const login = await playwright.request.newContext({ baseURL: baseURL! });
  const cookie = await devLogin(login);
  await login.dispose();
  const authHeaders = { cookie, origin: baseURL! };

  const keyCtx = await playwright.request.newContext({ baseURL: baseURL! });
  const keyRes = await keyCtx.post("/api/auth/api-key/create", {
    headers: authHeaders,
    data: { name: "api-doc-test" },
  });
  expect(keyRes.ok(), await keyRes.text()).toBeTruthy();
  const apiKey = ((await keyRes.json()) as { key: string }).key;
  await keyCtx.dispose();

  // One empty-jar client for the rest: authed setup calls pass authHeaders; the
  // documented curls below pass only what the doc shows (x-api-key or nothing),
  // so key-auth is exercised on its own exactly as a reader would.
  const client = await playwright.request.newContext({ baseURL: baseURL! });

  const compRes = await client.post("/api/comp", {
    headers: authHeaders,
    data: { name: `API Doc Comp ${Date.now()}`, category: "hg" },
  });
  expect(compRes.ok(), await compRes.text()).toBeTruthy();
  const compId = ((await compRes.json()) as { comp_id: string }).comp_id;

  const taskRes = await client.post(`/api/comp/${compId}/task`, {
    headers: authHeaders,
    data: {
      name: "API Doc Task",
      task_date: "2026-01-15",
      pilot_classes: ["open"],
      xctsk: JSON.parse(readFileSync(SAMPLE_XCTSK, "utf8")),
    },
  });
  expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
  const taskId = ((await taskRes.json()) as { task_id: string }).task_id;

  // ── Run each documented curl ───────────────────────────────────────────────
  const gzipped = gzipSync(readFileSync(SAMPLE_IGC));

  // pilot id is unknown until the self-upload block returns it; later blocks
  // (upload-on-behalf, download) substitute it in.
  let pilotId = "";
  const subst = (): Record<string, string> => ({
    [PLACEHOLDER.comp]: compId,
    [PLACEHOLDER.task]: taskId,
    [PLACEHOLDER.key]: apiKey,
    ...(pilotId ? { [PLACEHOLDER.pilot]: pilotId } : {}),
  });

  const blocks = extractCurlBlocks(md);
  expect(blocks.length, "expected curl examples in docs/api.md").toBeGreaterThan(5);

  for (const rawBlock of blocks) {
    const call = parseBlock(rawBlock, subst);

    // A block that still contains an un-substituted placeholder means the doc
    // introduced a new placeholder this harness doesn't know how to fill.
    expect(
      call.path.includes(PLACEHOLDER.pilot) ? "pilot-id not yet known" : call.path,
      `Unsubstituted placeholder in doc example:\n${rawBlock}`
    ).not.toContain("pilot-id not yet known");

    const res = await client.fetch(call.path, {
      method: call.method,
      headers: call.headers,
      ...(call.gzipBody ? { data: gzipped } : {}),
    });

    expect(
      res.status(),
      `Doc example did not succeed (${res.status()}):\n${rawBlock}\n→ ${call.method} ${call.path}`
    ).toBeLessThan(400);

    // Capture the pilot id the first time a self-upload reveals it.
    if (call.method === "POST" && /\/igc$/.test(call.path) && !pilotId) {
      const body = (await res.json()) as { comp_pilot_id?: string };
      if (body.comp_pilot_id) pilotId = body.comp_pilot_id;
    }

    // Light field pins on the load-bearing read responses — catches a rename of
    // a field the doc documents even when the status stays 200.
    if (call.method === "GET" && call.path === "/api/comp") {
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.comps), `GET /api/comp must return "comps"`).toBeTruthy();
    }
    if (call.method === "GET" && /\/scores$/.test(call.path)) {
      const body = (await res.json()) as Record<string, unknown>;
      expect("stale" in body && "computed_at" in body, "comp scores fields").toBeTruthy();
    }
    if (call.method === "GET" && /\/task\/[^/]+\/score$/.test(call.path)) {
      const body = (await res.json()) as Record<string, unknown>;
      expect("stale" in body, "task score must return a stale flag").toBeTruthy();
    }
  }

  // The doc documents an upload-on-behalf and a download example, both keyed on
  // a pilot id — so the harness must have discovered one along the way.
  expect(pilotId, "a self-upload example should have registered a pilot").not.toBe("");

  await client.dispose();
});
