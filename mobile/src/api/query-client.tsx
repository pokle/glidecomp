/**
 * Server state: TanStack Query, with its cache persisted to the phone so a
 * comp read on the hill this morning is still there with no signal this
 * afternoon (stage 2's offline reading).
 *
 * - Queries do not retry on their own: `getJson` already applies the
 *   website's retry rules, so there is one set of rules, not two.
 * - `offlineFirst`: with no signal, a query still tries once and then keeps
 *   whatever it last had. Nothing is replaced by an empty state because a
 *   request failed; the screen says what it is showing instead (StaleBanner).
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import * as Network from 'expo-network';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

const DAY_MS = 86_400_000;

/** Bump when a cached payload's shape changes, to drop what phones hold. */
const CACHE_BUSTER = 'stage-2';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * DAY_MS,
      staleTime: 60_000,
      retry: false,
      networkMode: 'offlineFirst',
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: Storage,
  key: 'glidecomp-query-cache',
  throttleTime: 2_000,
});

function useConnectivity() {
  useEffect(() => {
    onlineManager.setEventListener((setOnline) => {
      const apply = (state: Network.NetworkState) =>
        setOnline(state.isInternetReachable ?? state.isConnected ?? true);
      // The listener reports changes only: a launch with no signal at all
      // must still learn it is offline.
      Network.getNetworkStateAsync().then(apply, () => {});
      const sub = Network.addNetworkStateListener(apply);
      return () => sub.remove();
    });
    const appState = AppState.addEventListener('change', (status) =>
      focusManager.setFocused(status === 'active'),
    );
    return () => appState.remove();
  }, []);
}

export function QueryProvider({ children }: PropsWithChildren) {
  useConnectivity();
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 30 * DAY_MS, buster: CACHE_BUSTER }}>
      {children}
    </PersistQueryClientProvider>
  );
}
