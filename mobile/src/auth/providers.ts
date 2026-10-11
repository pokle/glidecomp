/**
 * Google and Apple sign-in, natively: the platform's own sheet hands the app
 * an ID token, and the auth worker checks it against Google's or Apple's
 * public keys. The session cookie then comes back in the response, never in
 * a URL another app could intercept (docs/auth.md, "The native app").
 *
 * Each is offered only where this build can complete it: Google needs the
 * app's client ids (app.config.ts), Apple needs an iOS build whose team has
 * the capability.
 */
import type { AuthUser } from '@glidecomp/client/account';
import { GoogleSignin, isCancelledResponse, isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { authClient } from './client';

const extra = (Constants.expoConfig?.extra ?? {}) as {
  googleWebClientId?: string;
  googleIosClientId?: string;
  appleSignIn?: boolean;
};

export const GOOGLE_AVAILABLE =
  !!extra.googleWebClientId && (Platform.OS === 'android' || !!extra.googleIosClientId);

export const APPLE_AVAILABLE = Platform.OS === 'ios' && !!extra.appleSignIn;

/** A sign-in that ended: with a user, or because the pilot backed out. */
export type ProviderResult = { kind: 'signed-in'; user: AuthUser | undefined; name?: string } | { kind: 'cancelled' };

/** A sign-in the provider or the worker refused; `message` is for the reader. */
export class SignInError extends Error {}

let googleConfigured = false;

export async function signInWithGoogle(): Promise<ProviderResult> {
  if (!googleConfigured) {
    GoogleSignin.configure({ webClientId: extra.googleWebClientId, iosClientId: extra.googleIosClientId });
    googleConfigured = true;
  }
  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) return { kind: 'cancelled' };
    const token = response.data.idToken;
    if (!token) throw new SignInError('Google didn’t confirm who you are. Try again.');
    const { data, error } = await authClient.signIn.social({ provider: 'google', idToken: { token } });
    if (error) throw new SignInError('GlideComp couldn’t sign you in with Google. Try again.');
    return { kind: 'signed-in', user: (data as unknown as { user?: AuthUser } | null)?.user };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.IN_PROGRESS) return { kind: 'cancelled' };
    throw err;
  }
}

export async function signInWithApple(): Promise<ProviderResult> {
  const nonce = Crypto.randomUUID();
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return { kind: 'cancelled' };
    throw err;
  }
  if (!credential.identityToken) throw new SignInError('Apple didn’t confirm who you are. Try again.');
  const { data, error } = await authClient.signIn.social({
    provider: 'apple',
    idToken: { token: credential.identityToken, nonce },
  });
  if (error) throw new SignInError('GlideComp couldn’t sign you in with Apple. Try again.');
  // Apple tells the app the pilot's name on the FIRST sign-in only, and the
  // worker will not take it inside the token request (SEC-55). It goes in
  // through the profile instead, under the same checks as any other name.
  const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ').trim();
  return { kind: 'signed-in', user: (data as unknown as { user?: AuthUser } | null)?.user, name: name || undefined };
}
