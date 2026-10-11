import { onlineManager, type UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { DefaultTheme, ThemeProvider } from 'expo-router';
import { Text } from 'react-native';

import { ApiError } from '@/api/client';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

function result(over: Partial<UseQueryResult<string>>): UseQueryResult<string> {
  return {
    data: undefined,
    error: null,
    isError: false,
    dataUpdatedAt: Date.now() - 5 * 60_000,
    refetch: jest.fn(),
    ...over,
  } as unknown as UseQueryResult<string>;
}

async function show(query: UseQueryResult<string>) {
  await render(
    <ThemeProvider value={DefaultTheme}>
      <StaleBanner query={query} />
      <QueryGate query={query} loading="Loading…" notFound="Not here.">
        {(data) => <Text>{data}</Text>}
      </QueryGate>
    </ThemeProvider>,
  );
}

describe('a failure to ask is not an answer (#481)', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('keeps what the reader saw, and says so, when a refresh is dropped', async () => {
    onlineManager.setOnline(false);
    await show(result({ data: 'Corryong Cup', isError: true, error: new TypeError('Network request failed') }));
    expect(screen.getByText('Corryong Cup')).toBeOnTheScreen();
    expect(screen.getByText('No signal — showing what you saw 5 minutes ago.')).toBeOnTheScreen();
  });

  it('blames the server, not the signal, when it answered with a 5xx', async () => {
    await show(result({ data: 'Corryong Cup', isError: true, error: new ApiError(503) }));
    expect(screen.getByText('Corryong Cup')).toBeOnTheScreen();
    expect(screen.getByText('GlideComp isn’t answering — showing what you saw 5 minutes ago.')).toBeOnTheScreen();
  });

  it('shows no banner over fresh data', async () => {
    await show(result({ data: 'Corryong Cup' }));
    expect(screen.queryByTestId('stale-banner')).toBeNull();
  });

  it('never calls a dropped request "not found"', async () => {
    await show(result({ isError: true, error: new TypeError('Network request failed') }));
    expect(screen.getByTestId('load-error')).toBeOnTheScreen();
    expect(screen.queryByText('Not here.')).toBeNull();
  });

  it('says "not found" only for a real 404', async () => {
    await show(result({ isError: true, error: new ApiError(404) }));
    expect(screen.getByText('Not here.')).toBeOnTheScreen();
  });
});
