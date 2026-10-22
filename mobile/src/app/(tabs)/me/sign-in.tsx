/**
 * Sign in with an emailed code (the website's /signin, two steps: address,
 * then the 6-digit code). The code verifies itself once all six digits are
 * in, as on the website; iOS offers it from Mail above the keyboard.
 *
 * Its wording is the website's, so a pilot reads one set of sentences.
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import type { TextInput } from 'react-native';

import { authClient } from '@/auth/client';
import { completeSignIn } from '@/auth/session';
import { Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, TextButton } from '@/ui/form';
import type { AuthUser } from '@glidecomp/client/account';

const RESEND_COOLDOWN_S = 60;

type ErrorLike = { status?: number; code?: string } | null | undefined;

function sendError(err: ErrorLike): string {
  return err?.status === 429
    ? 'Too many codes requested. Wait a minute, then try again.'
    : 'Could not send the code. Check the address and try again.';
}

function verifyError(err: ErrorLike): string {
  if (err?.code === 'OTP_EXPIRED') return 'That code has expired. Send yourself a new one.';
  if (err?.code === 'TOO_MANY_ATTEMPTS') return 'Too many attempts with that code. Send yourself a new one.';
  if (err?.status === 429) return 'Too many tries in a row. Wait a minute, then try again.';
  return 'That code didn’t work. Check it and try again.';
}

export default function EmailSignIn() {
  // The sign-in email's link (stage 9) opens here with the code and address
  // already in hand, from https://glidecomp.com/signin/app#otp=…&email=….
  const linked = useLocalSearchParams<{ otp?: string; email?: string }>();
  const [step, setStep] = useState<'email' | 'code'>(linked.otp && linked.email ? 'code' : 'email');
  const [email, setEmail] = useState(linked.email ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send(isResend: boolean) {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await authClient.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in' });
      if (err) {
        setError(sendError(err));
        return;
      }
      setStep('code');
      setCode('');
      setCooldown(RESEND_COOLDOWN_S);
      setStatus(isResend ? `New code sent to ${address}.` : `Code sent to ${address}. It expires in 10 minutes.`);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch {
      setError('No signal. Try again when you have some.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(otp: string) {
    setBusy(true);
    setError(null);
    setStatus('Checking code…');
    try {
      const { data, error: err } = await authClient.signIn.emailOtp({ email: email.trim(), otp });
      if (err) {
        setCode('');
        setStatus(null);
        setError(verifyError(err));
        codeRef.current?.focus();
        return;
      }
      // The worker's user carries `username` too; Better Auth's client type
      // does not know of the additional field.
      await completeSignIn((data as unknown as { user?: AuthUser } | null)?.user);
      router.back();
    } catch {
      setStatus(null);
      setError('No signal. Try again when you have some.');
    } finally {
      setBusy(false);
    }
  }

  // Opened from the email's link: the code is already here, so check it once.
  const usedLink = useRef(false);
  useEffect(() => {
    const otp = linked.otp?.replace(/\D/g, '').slice(0, 6);
    if (usedLink.current || !otp || otp.length !== 6 || !linked.email) return;
    usedLink.current = true;
    setCode(otp);
    void verify(otp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked.otp, linked.email]);

  return (
    <FormScreen testID="email-sign-in-screen">
      <Stack.Screen options={{ title: 'Sign in', headerLargeTitle: false }} />
      {step === 'email' ? (
        <>
          <FormCard>
            <Field
              testID="email-field"
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={() => void send(false)}
              autoFocus
            />
          </FormCard>
          <PrimaryButton
            testID="send-code"
            title="Email me a sign-in code"
            pending={busy}
            pendingLabel="Sending your code"
            disabled={!email.trim()}
            onPress={() => void send(false)}
          />
          <FormHint>No password needed — we’ll email you a 6-digit code.</FormHint>
        </>
      ) : (
        <>
          {status ? (
            <FormMessage kind="status" testID="sign-in-status">
              {status}
            </FormMessage>
          ) : null}
          <FormCard>
            <Field
              ref={codeRef}
              testID="code-field"
              label="6-digit sign-in code"
              value={code}
              onChangeText={(text) => {
                const digits = text.replace(/\D/g, '').slice(0, 6);
                setCode(digits);
                if (digits.length === 6) void verify(digits);
              }}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              editable={!busy}
              style={{ fontSize: 28, letterSpacing: 8, textAlign: 'center', fontVariant: ['tabular-nums'] }}
            />
          </FormCard>
          <TextButton
            testID="resend-code"
            title={cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            disabled={busy || cooldown > 0}
            onPress={() => void send(true)}
          />
          <TextButton
            testID="different-email"
            title="Use a different email"
            disabled={busy}
            onPress={() => {
              setStep('email');
              setStatus(null);
              setError(null);
              setCode('');
            }}
          />
        </>
      )}
      {error ? (
        <FormMessage kind="error" testID="sign-in-error">
          {error}
        </FormMessage>
      ) : null}
    </FormScreen>
  );
}
