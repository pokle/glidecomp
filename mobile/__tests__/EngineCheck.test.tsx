import { render, screen } from '@testing-library/react-native';
import { DefaultTheme, ThemeProvider } from 'expo-router';

import { EngineCheck } from '@/components/EngineCheck';

describe('<EngineCheck />', () => {
  it('shows the scored sample once the engine finishes', async () => {
    await render(
      <ThemeProvider value={DefaultTheme}>
        <EngineCheck />
      </ThemeProvider>,
    );
    expect(await screen.findByText('Task distance 78.85 km')).toBeOnTheScreen();
    expect(screen.getByText('Jon Durand, 1000 points')).toBeOnTheScreen();
    expect(screen.getByTestId('engine-check-times')).toHaveTextContent(
      'Start 15:30:00, ESS 17:07:55 (Australia/Melbourne)',
    );
  });
});
