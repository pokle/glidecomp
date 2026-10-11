/**
 * The pilot profile — name and contact, pilot IDs — as Settings → Profile
 * edits it on the website, with the same fields and labels
 * (@glidecomp/client/account). The display name is the account's too: the
 * server renames both at once (issue #539).
 *
 * Leaving with unsaved changes asks first, as the website does.
 */
import {
  ID_FIELDS,
  NAME_CONTACT_FIELDS,
  PROFILE_FIELDS,
  type PilotProfile,
  type ProfileFieldKey,
} from '@glidecomp/client/account';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useNavigation, usePreventRemove } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { ProfileSaveError, saveProfile } from '@/api/account';
import { useProfile } from '@/api/queries';
import { refreshIdentity, useUserId } from '@/auth/session';
import { Field, FormCard, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

type Values = Record<ProfileFieldKey, string>;

function valuesOf(profile: PilotProfile): Values {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, profile[f.key] ?? ''])) as Values;
}

export default function ProfileScreen() {
  const userId = useUserId();
  const profile = useProfile(userId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Profile', headerLargeTitle: false }} />
      <StaleBanner query={profile} />
      <QueryGate query={profile} loading="Loading your profile…" notFound="">
        {(data) => <ProfileForm saved={data} />}
      </QueryGate>
    </View>
  );
}

function ProfileForm({ saved }: { saved: PilotProfile }) {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const userId = useUserId();
  const [baseline, setBaseline] = useState<Values>(() => valuesOf(saved));
  const [values, setValues] = useState<Values>(baseline);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'error'; text: string } | null>(null);
  const dirty = PROFILE_FIELDS.some((f) => values[f.key] !== baseline[f.key]);

  // A refetch that lands while the form is clean shows the newer values.
  useEffect(() => {
    if (!dirty) {
      const next = valuesOf(saved);
      setBaseline(next);
      setValues(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  usePreventRemove(dirty && !saving, ({ data }) => {
    Alert.alert('Discard profile changes?', 'Your profile has unsaved changes. Leaving this page will discard them.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  async function save() {
    setMessage(null);
    // Cleared fields are stored as nulls, not "" — the website's rule.
    const payload: Partial<PilotProfile> = {};
    for (const field of PROFILE_FIELDS) {
      const value = values[field.key].trim();
      payload[field.key] = value === '' ? null : value;
    }
    if (payload.name === null) {
      setMessage({ kind: 'error', text: 'Display name is required' });
      return;
    }
    setSaving(true);
    try {
      const stored = await saveProfile(payload);
      const next = valuesOf({ ...saved, ...stored });
      setBaseline(next);
      setValues(next);
      queryClient.setQueryData(['profile', userId], stored);
      setMessage({
        kind: 'status',
        text: 'Profile saved. Any matching competition registrations have been linked to this account.',
      });
      // The account's name changed with it; the Me tab shows the new one.
      void refreshIdentity();
      void queryClient.invalidateQueries({ queryKey: ['registrations'] });
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof ProfileSaveError ? err.message : 'Network error. Please try again.',
      });
    } finally {
      setSaving(false);
    }
  }

  const field = (f: (typeof PROFILE_FIELDS)[number]) => (
    <Field
      key={f.key}
      testID={`profile-${f.key}`}
      label={f.key === 'name' ? `${f.label} (required)` : f.label}
      value={values[f.key]}
      onChangeText={(text) => {
        setValues((v) => ({ ...v, [f.key]: text }));
        // A stale "Profile saved" beside re-edited fields reads as a lie.
        setMessage(null);
      }}
      autoCapitalize={f.key.endsWith('_id') ? 'characters' : f.key.includes('phone') ? 'none' : 'words'}
      autoCorrect={false}
      keyboardType={f.key.includes('phone') ? 'phone-pad' : 'default'}
      textContentType={f.key === 'name' ? 'name' : f.key === 'phone' ? 'telephoneNumber' : 'none'}
    />
  );

  return (
    <FormScreen testID="profile-screen">
      <FormCard title="Name and contact">{NAME_CONTACT_FIELDS.map(field)}</FormCard>
      <FormCard title="Pilot IDs">{ID_FIELDS.map(field)}</FormCard>
      {message ? (
        <FormMessage kind={message.kind} testID="profile-message">
          {message.text}
        </FormMessage>
      ) : null}
      <PrimaryButton
        testID="save-profile"
        title="Save profile"
        pending={saving}
        pendingLabel="Saving your profile"
        disabled={!dirty}
        onPress={() => void save()}
      />
    </FormScreen>
  );
}
