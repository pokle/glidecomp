/**
 * A dead link is a searchable one (root CLAUDE.md): when a link opens a
 * competition, task or pilot that no longer resolves, read the words out of
 * the dead path and offer what carries those words NOW — the website's
 * NotFound, through the same `not-found-search` module and the same
 * `GET /api/comp/lookup`. The lookup knows nothing about URLs; the paths it
 * suggests are built here, so they are always the app's own.
 */
import { appRouteForUrl } from '@glidecomp/client/app-links';
import {
  buildSuggestions,
  lookupParams,
  parsePathIdentity,
  type LookupResults,
} from '@glidecomp/client/not-found-search';
import { useQuery } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';

import { api, getJson } from '@/api/client';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export function LinkRepair({ message }: { message: string }) {
  const pathname = usePathname();
  const identity = parsePathIdentity(pathname);
  const params = lookupParams(identity);
  const lookup = useQuery({
    queryKey: ['lookup', params?.toString() ?? ''],
    enabled: params !== null,
    meta: { persist: false },
    queryFn: ({ signal }) =>
      getJson<LookupResults>(
        (s) => api.api.comp.lookup.$get({ query: Object.fromEntries(params!) as never }, { init: { signal: s } }),
        signal,
      ),
  });
  const suggestions = lookup.data ? buildSuggestions(identity, lookup.data) : [];
  return (
    <GroupedList testID="link-repair">
      <Group>
        <Note>{message}</Note>
      </Group>
      {params && lookup.isLoading ? (
        <Group>
          <Note>Looking for what this link meant…</Note>
        </Group>
      ) : null}
      {suggestions.length > 0 ? (
        <Group title="Did you mean" testID="link-repair-suggestions">
          {suggestions.map((s) => (
            <Row
              key={s.path}
              title={s.label}
              detail={s.context}
              onPress={() => router.replace((appRouteForUrl(s.path) ?? s.path) as never)}
            />
          ))}
        </Group>
      ) : null}
      <Group>
        <Row title="Search competitions" detail="Comps, tasks, pilots and turnpoints" onPress={() => router.navigate('/comp' as never)} />
      </Group>
    </GroupedList>
  );
}
