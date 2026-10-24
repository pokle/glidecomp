import { describe, expect, it } from "vitest";
import { oauthResumePath } from "./oauth-resume";

const signed = (extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: "abc",
    redirect_uri: "http://127.0.0.1:4000/cb",
    scope: "openid comp:read",
    state: "s1",
    code_challenge: "xyz",
    code_challenge_method: "S256",
    exp: "1792845594",
    ba_iat: "1792844694",
    sig: "signature",
    ...extra,
  });

describe("oauthResumePath", () => {
  it("sends a signed authorisation request back to authorize, without its signing params", () => {
    const path = oauthResumePath(signed())!;
    const url = new URL(path, "https://glidecomp.com");
    expect(url.origin).toBe("https://glidecomp.com");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("code_challenge")).toBe("xyz");
    for (const p of ["sig", "exp", "ba_iat", "ba_pl"]) expect(url.searchParams.has(p)).toBe(false);
  });

  it("drops a `next` riding along, so it can't steer the resume", () => {
    expect(oauthResumePath(signed({ next: "https://evil.example" }))).not.toContain("next=");
  });

  it("is not an authorisation request without a signature, a client or a code response", () => {
    const missing = (name: string) => {
      const q = signed();
      q.delete(name);
      return q;
    };
    expect(oauthResumePath(missing("sig"))).toBeNull();
    expect(oauthResumePath(missing("client_id"))).toBeNull();
    expect(oauthResumePath(signed({ response_type: "token" }))).toBeNull();
    expect(oauthResumePath(new URLSearchParams({ next: "/comp" }))).toBeNull();
  });
});
