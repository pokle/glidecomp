/**
 * Sign-in page: Google OAuth plus passwordless email one-time codes
 * (docs/2026-07-14-email-otp-signin-plan.md). Two steps — email → code —
 * with a deep-link fast path: the OTP email links here with
 * `#otp=123456&email=…`; the code rides in the URL fragment so it never
 * reaches server logs, and we strip it from the address bar on arrival.
 *
 * Renders outside the Shell (like /onboarding): it's a focused card, not a
 * page in the app chrome. SSR-note: this file is imported by the shared
 * route tree, so no window/document at module scope.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Button } from "@/react/ui/button";
import { Field, FieldLabel } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/react/ui/input-otp";
import {
  sendSignInOtp,
  signInWithGoogle,
  signInWithOtp,
} from "../../auth/client";
import { DEV_SIGN_IN_ENABLED, signInAsDev, useUser } from "../lib/user";
import { safeNext } from "../lib/safe-next";

const RESEND_COOLDOWN_S = 60;

function parseOtpHash(hash: string): { otp: string; email: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const otp = params.get("otp");
  const email = params.get("email");
  return otp && email ? { otp, email } : null;
}

export function SignIn() {
  const { user, loading } = useUser();
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get("next"));

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Announced via aria-live; also the "code sent" confirmation. */
  const [status, setStatus] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const emailId = useId();
  const otpRef = useRef<HTMLInputElement>(null);
  // The emailed deep link is single-shot: consume it once, then behave like
  // a normal manual visit (a failed link degrades to the code form).
  const consumedHash = useRef(false);

  useEffect(() => {
    document.title = "GlideComp - Sign in";
  }, []);

  // Already signed in (including arriving via an already-used email link a
  // second time) — nothing to do here.
  useEffect(() => {
    if (!loading && user) window.location.replace(next);
  }, [user, loading, next]);

  async function verify(targetEmail: string, otp: string) {
    setBusy(true);
    setError(null);
    setStatus("Checking code…");
    const { error: err } = await signInWithOtp(targetEmail, otp);
    if (err) {
      setBusy(false);
      setCode("");
      setStatus(null);
      setError(
        err.code === "OTP_EXPIRED"
          ? "That code has expired. Send yourself a new one."
          : err.code === "TOO_MANY_ATTEMPTS"
            ? "Too many attempts with that code. Send yourself a new one."
            : err.status === 429
              ? "Too many tries in a row. Wait a minute, then try again."
              : "That code didn't work. Check it and try again."
      );
      otpRef.current?.focus();
      return;
    }
    // Full page load (not navigate): UserProvider caches /api/auth/me per
    // page load, so a client-side hop would still look signed out.
    window.location.href = next;
  }

  async function send(targetEmail: string, isResend: boolean) {
    setBusy(true);
    setError(null);
    const { error: err } = await sendSignInOtp(targetEmail);
    setBusy(false);
    if (err) {
      setError(
        err.status === 429
          ? "Too many codes requested. Wait a minute, then try again."
          : "Could not send the code. Check the address and try again."
      );
      return;
    }
    setStep("code");
    setCode("");
    setCooldown(RESEND_COOLDOWN_S);
    setStatus(
      isResend
        ? `New code sent to ${targetEmail}.`
        : `Code sent to ${targetEmail}. It expires in 10 minutes.`
    );
  }

  // Emailed deep link: verify immediately; strip the fragment from the URL
  // and from history first so the code can't linger in the address bar.
  useEffect(() => {
    if (consumedHash.current) return;
    consumedHash.current = true;
    const fromHash = parseOtpHash(window.location.hash);
    if (!fromHash) return;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setEmail(fromHash.email);
    setStep("code");
    void verify(fromHash.email, fromHash.otp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Focus the code input when the code step appears (not on deep-link
  // auto-verify, where focus would fight the redirect).
  useEffect(() => {
    if (step === "code" && !busy) otpRef.current?.focus();
  }, [step, busy]);

  if (loading || user) return <p role="status">Loading…</p>;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-xl border px-6 py-8">
        <h1 className="text-2xl font-bold">Sign in to GlideComp</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Track your flights and enter competitions.
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Button type="button" onClick={() => void signInWithGoogle(next)}>
            Continue with Google
          </Button>
          {DEV_SIGN_IN_ENABLED ? (
            <Button type="button" variant="outline" onClick={() => void signInAsDev()}>
              Sign in (dev)
            </Button>
          ) : null}
        </div>

        <div className="my-6 flex items-center gap-3" role="separator" aria-label="or">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Screen-reader announcements for send/verify progress. */}
        <p aria-live="polite" role="status" className="sr-only">
          {status ?? ""}
        </p>

        {step === "email" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = email.trim();
              if (trimmed) void send(trimmed, false);
            }}
            className="flex flex-col gap-4"
          >
            <Field>
              <FieldLabel htmlFor={emailId}>Email</FieldLabel>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in code"}
            </Button>
            <p className="text-xs text-muted-foreground">
              No password needed — we'll email you a 6-digit code.
            </p>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm" aria-hidden={status === null}>
              {status ?? `Enter the code sent to ${email}.`}
            </p>
            <InputOTP
              ref={otpRef}
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
              onComplete={(value: string) => void verify(email, value)}
              disabled={busy}
              containerClassName="justify-center"
              aria-label="6-digit sign-in code"
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <InputOTPSlot key={i} index={i} className="size-10 text-base" />
                ))}
              </InputOTPGroup>
            </InputOTP>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setStatus(null);
                  setError(null);
                  setCode("");
                }}
              >
                Use a different email
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || cooldown > 0}
                onClick={() => void send(email, true)}
              >
                {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {/* Competitions list is public — an escape hatch that isn't sign-in. */}
        <Link to="/comp" className="underline underline-offset-4 hover:text-foreground">
          Browse competitions without signing in
        </Link>
      </p>
    </main>
  );
}
