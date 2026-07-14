/**
 * Email OTP sign-in (docs/2026-07-14-email-otp-signin-plan.md).
 *
 * Local dev never sends real email: the auth worker captures the code
 * in-memory and exposes it via GET /api/auth/dev-last-otp (gated on
 * isLocalDev, 404 in production).
 *
 * Rate-limit isolation: local dev has no real client IP, so the worker
 * would key every request into ONE shared bucket and test runs would 429
 * each other. Each test therefore sends a unique x-test-client-ip — a
 * header the worker trusts only when isLocalDev() (see auth.ts) — giving
 * every test (and every re-run) its own per-IP bucket at the real
 * production limits.
 */
import { test, expect } from "@playwright/test";

let ipCounter = 0;
/** Unique per test AND per run (runs seconds apart never collide). */
function testIp(): string {
  const t = Math.floor(Date.now() / 1000);
  return `10.${(t >> 8) & 255}.${t & 255}.${ipCounter++}`;
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-test-client-ip": testIp() });
});

async function fetchDevOtp(
  request: import("@playwright/test").APIRequestContext,
  email: string
): Promise<string> {
  const res = await request.get(
    `/api/auth/dev-last-otp?email=${encodeURIComponent(email)}`
  );
  expect(res.ok()).toBe(true);
  const { otp } = (await res.json()) as { otp: string };
  expect(otp).toMatch(/^\d{6}$/);
  return otp;
}

test("sign in with an emailed code (manual entry)", async ({ page }) => {
  const email = `otp-ui-${String(Date.now()).slice(-8)}@test.local`;

  await page.goto("/signin");
  await expect(
    page.getByRole("heading", { name: "Sign in to GlideComp" })
  ).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();

  // Code step: the OTP input takes focus and auto-submits on the 6th digit.
  const otpInput = page.getByRole("textbox", { name: "6-digit sign-in code" });
  await expect(otpInput).toBeVisible();
  const otp = await fetchDevOtp(page.request, email);
  await otpInput.fill(otp);

  // Fresh user, no username → the Shell's onboarding gate takes over.
  await page.waitForURL("**/onboarding");
});

test("sign in via the emailed deep link (#otp=…&email=…)", async ({ page }) => {
  const email = `otp-link-${String(Date.now()).slice(-8)}@test.local`;

  const sendRes = await page.request.post(
    "/api/auth/email-otp/send-verification-otp",
    { data: { email, type: "sign-in" }, headers: { "x-test-client-ip": testIp() } }
  );
  expect(sendRes.ok()).toBe(true);
  const otp = await fetchDevOtp(page.request, email);

  // The link the email carries: code in the FRAGMENT (never sent to the
  // server); the page consumes it, strips it, and signs in unprompted.
  await page.goto(`/signin#otp=${otp}&email=${encodeURIComponent(email)}`);
  await page.waitForURL("**/onboarding");
});

test("a wrong code shows an error and allows retry", async ({ page }) => {
  const email = `otp-wrong-${String(Date.now()).slice(-8)}@test.local`;

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();

  const otpInput = page.getByRole("textbox", { name: "6-digit sign-in code" });
  await expect(otpInput).toBeVisible();
  const otp = await fetchDevOtp(page.request, email);
  const wrong = otp === "000000" ? "000001" : "000000";
  await otpInput.fill(wrong);

  await expect(page.getByRole("alert")).toContainText(/didn't work/);
  // Still on the code step — the right code recovers the flow.
  await otpInput.fill(otp);
  await page.waitForURL("**/onboarding");
});

test("send endpoint rate-limits with Retry-After", async ({ request }) => {
  // Its own bucket: rapid sends from one "IP" must 429 within the cap.
  const ip = testIp();
  let blocked: import("@playwright/test").APIResponse | null = null;
  for (let i = 0; i < 8; i++) {
    const res = await request.post(
      "/api/auth/email-otp/send-verification-otp",
      {
        data: {
          email: `otp-limit-${i}-${String(Date.now()).slice(-8)}@test.local`,
          type: "sign-in",
        },
        headers: { "x-test-client-ip": ip },
      }
    );
    if (res.status() === 429) {
      blocked = res;
      break;
    }
    expect(res.ok()).toBe(true);
  }
  expect(blocked, "expected a 429 within 8 rapid sends").not.toBeNull();
  expect(blocked!.headers()["retry-after"]).toBeTruthy();
});
