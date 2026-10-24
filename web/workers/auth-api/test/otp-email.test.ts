// Unit tests for the pure OTP email builder — content, link shape, and the
// rule that the code rides in the URL fragment (never the query string, so
// it stays out of server logs).

import { describe, expect, test } from "vitest";
import {
  OTP_FROM_ADDRESS,
  buildOtpEmail,
  buildOtpSignInUrl,
} from "../src/otp-email";

describe("buildOtpSignInUrl", () => {
  test("code and email live in the fragment, not the query string", () => {
    const url = buildOtpSignInUrl("https://glidecomp.com", "pilot@example.com", "123456");
    expect(url).toBe(
      "https://glidecomp.com/signin#otp=123456&email=pilot%40example.com"
    );
    expect(new URL(url).search).toBe("");
  });

  test("strips trailing slash from the base URL", () => {
    expect(buildOtpSignInUrl("https://glidecomp.com/", "a@b.c", "000000")).toBe(
      "https://glidecomp.com/signin#otp=000000&email=a%40b.c"
    );
  });

  test("URL-encodes emails with fragment-hostile characters", () => {
    const url = buildOtpSignInUrl(
      "https://glidecomp.com",
      "first+tag@example.com",
      "654321"
    );
    expect(url).toContain("email=first%2Btag%40example.com");
  });
});

describe("buildOtpEmail", () => {
  const msg = buildOtpEmail({
    email: "pilot@example.com",
    otp: "123456",
    baseURL: "https://glidecomp.com",
  });

  test("addresses and subject carry the code", () => {
    expect(msg.to).toBe("pilot@example.com");
    expect(msg.from).toBe(OTP_FROM_ADDRESS);
    expect(msg.subject).toContain("123456");
  });

  test("text part has the code and the deep link", () => {
    expect(msg.text).toContain("123456");
    expect(msg.text).toContain(
      "https://glidecomp.com/signin#otp=123456&email=pilot%40example.com"
    );
    expect(msg.text).toContain("expires in 10 minutes");
  });

  test("html part has the code and the deep link (& escaped in the href)", () => {
    expect(msg.html).toContain("123456");
    expect(msg.html).toContain(
      "https://glidecomp.com/signin#otp=123456&amp;email=pilot%40example.com"
    );
  });

  test("html escapes a hostile email address", () => {
    const evil = buildOtpEmail({
      email: `x"<img src=x onerror=alert(1)>@example.com`,
      otp: "111111",
      baseURL: "https://glidecomp.com",
    });
    expect(evil.html).not.toContain("<img");
  });
});
