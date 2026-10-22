/**
 * Me (IA §2): the account, its pilot profile, the reader's settings, and
 * sign out. Signed out, this tab IS the sign-in surface, so signing in is
 * never a modal ambush in the middle of something else (stage 4).
 *
 * Every group is a direct child of the list, never returned from a component
 * or a fragment: Android's list recognises a section only by its own type,
 * and drops or re-wraps anything else (mobile/CLAUDE.md, "Lists").
 */
import { needsOnboarding } from '@glidecomp/client/account';
import * as AppleAuthentication from 'expo-apple-authentication';
import { router, Stack, useTheme } from 'expo-router';
import { useState } from 'react';
import { Alert, useColorScheme } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import { API_ORIGIN, WRITES_ALLOWED } from '@/api/config';
import { useProfile } from '@/api/queries';
import { APPLE_AVAILABLE, GOOGLE_AVAILABLE, signInWithApple, signInWithGoogle, SignInError } from '@/auth/providers';
import { CRASH_REPORTS } from '@/crash-reports';
import { finishProviderSignIn } from '@/auth/sign-in';
import { deleteAccount, signOut, useIdentity } from '@/auth/session';
import { ago } from '@/lib/ago';
import { accountTitle, appearanceLabel, pilotIdSummary } from '@/lib/me-labels';
import { useAppearance } from '@/settings/appearance';
import { useSubmissions } from '@/submit/queue';
import { useUnits } from '@/settings/units';
import { ActionRow, Embedded, GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export default function Me() {
  const identity = useIdentity();
  const user = identity.kind === 'signed-in' ? identity.user : null;
  const profile = useProfile(user?.id ?? null);
  const units = useUnits();
  const appearance = useAppearance();
  const scheme = useColorScheme();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const uploads = useSubmissions().items;
  const waiting = uploads.filter((s) => s.status !== 'sent').length;

  const signInWith = async (provider: typeof signInWithGoogle) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await provider();
      if (result.kind === 'signed-in') await finishProviderSignIn(result);
    } catch (err) {
      Alert.alert('Couldn’t sign in', err instanceof SignInError ? err.message : 'Check your signal and try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'Signing in again takes an emailed code, or Google or Apple.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);

  const confirmDelete = () =>
    Alert.alert(
      'Delete account',
      'This will permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete my account',
          style: 'destructive',
          onPress: () =>
            deleteAccount().catch(() =>
              Alert.alert('Couldn’t delete your account', 'Check your signal and try again.'),
            ),
        },
      ],
    );

  return (
    <>
      <Stack.Screen options={{ title: 'Me' }} />
      <GroupedList testID="me">
        {identity.kind === 'signed-in' ? (
          <Group>
            <Row
              testID="account"
              title={accountTitle(identity.user)}
              detail={identity.user.name.trim() ? identity.user.email : undefined}
            />
            {identity.confirmed ? null : (
              <Note>{`No answer from GlideComp, so this is your sign-in as last checked, ${ago(identity.checkedAt, Date.now())}.`}</Note>
            )}
            {needsOnboarding(identity.user) ? (
              <Row
                testID="add-name"
                title="Add your name"
                detail="Organisers, scores and the activity log show it."
                onPress={() => router.push('/me/profile')}
              />
            ) : null}
          </Group>
        ) : identity.kind === 'checking' ? (
          <Group>
            <Note>Checking your sign-in…</Note>
          </Group>
        ) : !WRITES_ALLOWED ? (
          <Group>
            <Note>
              This development build reads glidecomp.com but never writes to it, so it can’t sign in there. Point it
              at your local workers to sign in.
            </Note>
          </Group>
        ) : (
          <Group title="Sign in">
            <Note>Sign in to follow your own competitions and flights, and to submit tracks.</Note>
            {APPLE_AVAILABLE ? (
              <Embedded testID="apple-sign-in">
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={
                    scheme === 'dark'
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={8}
                  style={{ height: 44, backgroundColor: colors.card }}
                  onPress={() => void signInWith(signInWithApple)}
                />
              </Embedded>
            ) : null}
            {GOOGLE_AVAILABLE ? (
              <ActionRow
                testID="google-sign-in"
                title="Continue with Google"
                onPress={() => void signInWith(signInWithGoogle)}
              />
            ) : null}
            <Row testID="email-sign-in" title="Email me a sign-in code" onPress={() => router.push('/me/sign-in')} />
          </Group>
        )}

        {user ? (
          <Group title="Pilot">
            <Row
              testID="profile-row"
              title="Profile"
              detail={pilotIdSummary(profile.data) ?? 'Name and contact, pilot IDs'}
              onPress={() => router.push('/me/profile')}
            />
          </Group>
        ) : null}

        {uploads.length > 0 ? (
          <Group title="Tracks">
            <Row
              testID="uploads-row"
              title="Track uploads"
              value={waiting > 0 ? `${waiting} on this phone` : undefined}
              detail={waiting > 0 ? 'Not submitted yet' : 'All submitted'}
              onPress={() => router.push('/me/uploads')}
            />
          </Group>
        ) : null}

        <Group title="Settings">
          <Row
            testID="units-row"
            title="Units"
            value={`${units.altitude}, ${units.distance}, ${units.speed}`}
            onPress={() => router.push('/me/units')}
          />
          <Row
            testID="appearance-row"
            title="Appearance"
            value={appearanceLabel(appearance)}
            onPress={() => router.push('/me/appearance')}
          />
        </Group>

        <Group title="This build">
          <Row
            title="Data from"
            value={API_ORIGIN.replace(/^https?:\/\//, '')}
            detail={WRITES_ALLOWED ? undefined : 'Read-only: a development build never writes to it'}
          />
          <Row
            testID="version-row"
            title="Version"
            value={Constants.expoConfig?.version ?? '–'}
            detail={Updates.updateId && !Updates.isEmbeddedLaunch ? `Update ${Updates.updateId.slice(0, 8)}, ${Updates.channel ?? 'no channel'}` : 'As installed'}
          />
          <Row
            title="Crash reports"
            value={CRASH_REPORTS ? 'On' : 'Off'}
            detail={CRASH_REPORTS ? 'Sent without your name, email or account' : undefined}
          />
          <Row title="Engine check" onPress={() => router.push('/me/engine-check')} />
        </Group>

        {user ? (
          <Group>
            <ActionRow testID="sign-out" title="Sign out" onPress={confirmSignOut} />
          </Group>
        ) : null}
        {user ? (
          <Group title="Danger zone">
            <Note>Permanently delete your account and all associated data. This cannot be undone.</Note>
            <ActionRow testID="delete-account" title="Delete account" destructive onPress={confirmDelete} />
          </Group>
        ) : null}
      </GroupedList>
    </>
  );
}
