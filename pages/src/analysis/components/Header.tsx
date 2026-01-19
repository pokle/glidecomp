/**
 * Header Component
 *
 * App header with branding, view mode toggle, and settings menu.
 * Uses Radix UI components for dropdown menus and toggle groups.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { useAppContext, type MapProviderType, type ViewMode, type Theme } from '../context/AppContext';

// Icons
const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
  </svg>
);

const DotsVerticalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <path d="M2.22 4.47a.75.75 0 0 1 1.06 0L6 7.19l2.72-2.72a.75.75 0 0 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L2.22 5.53a.75.75 0 0 1 0-1.06z" />
  </svg>
);

// Sample flight data
const SAMPLE_FLIGHTS = [
  { id: 'sample-rohan', name: 'Rohan Holt', file: '2026-01-05-RohanHolt-XFH-000-01.IGC' },
  { id: 'sample-shane', name: 'Shane Duncan', file: '2026-01-05-shane-dunc-XCT-SDU-02.igc' },
  { id: 'sample-gordon', name: 'Gordon Rigg', file: '20260105-132715-GordonRigg.999.igc' },
  { id: 'sample-burkitt', name: 'Burkitt', file: 'burkitt_18393_050126.igc' },
  { id: 'sample-durand', name: 'Durand', file: 'durand_45515_050126.igc' },
  { id: 'sample-holtkamp', name: 'Holtkamp', file: 'holtkamp_33915_050126.igc' },
];

export function Header() {
  const {
    viewMode,
    setViewMode,
    mapProvider,
    setMapProvider,
    theme,
    setTheme,
    altitudeColorsEnabled,
    setAltitudeColorsEnabled,
    is3DMode,
    set3DMode,
    loadIGCFile,
    showStatus,
  } = useAppContext();

  const handleViewModeChange = (value: string) => {
    if (value) {
      setViewMode(value as ViewMode);
    }
  };

  const handleProviderChange = (provider: MapProviderType) => {
    setMapProvider(provider);
  };

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
  };

  const handleLoadSample = async (filename: string) => {
    try {
      const response = await fetch(`/samples/${filename}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const content = await response.text();
      const file = new File([content], filename, { type: 'text/plain' });
      await loadIGCFile(file);
    } catch (err) {
      console.error('Failed to load sample file:', err);
      showStatus(`Failed to load sample: ${err}`, 'danger');
    }
  };

  return (
    <header className="header">
      <div className="header-brand">
        <a href="/">TaskScore</a>
        <span>IGC Analysis</span>
      </div>

      <div className="header-controls">
        {/* View mode toggle */}
        <ToggleGroup.Root
          className="toggle-group"
          type="single"
          value={viewMode}
          onValueChange={handleViewModeChange}
          aria-label="View mode"
        >
          <ToggleGroup.Item className="toggle-item" value="list" aria-label="List view">
            List
          </ToggleGroup.Item>
          <ToggleGroup.Item className="toggle-item" value="map" aria-label="Map view">
            Map
          </ToggleGroup.Item>
          <ToggleGroup.Item className="toggle-item" value="both" aria-label="Both view">
            Both
          </ToggleGroup.Item>
        </ToggleGroup.Root>

        {/* Settings dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn btn-sm" aria-label="Settings">
              <DotsVerticalIcon />
              <ChevronDownIcon />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content className="dropdown-content" sideOffset={5}>
              {/* Map Provider */}
              <DropdownMenu.Label className="dropdown-label">Map Provider</DropdownMenu.Label>
              <DropdownMenu.CheckboxItem
                className="dropdown-item"
                checked={mapProvider === 'leaflet'}
                onSelect={() => handleProviderChange('leaflet')}
              >
                <DropdownMenu.ItemIndicator className="dropdown-check">
                  <CheckIcon />
                </DropdownMenu.ItemIndicator>
                Leaflet
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.CheckboxItem
                className="dropdown-item"
                checked={mapProvider === 'mapbox'}
                onSelect={() => handleProviderChange('mapbox')}
              >
                <DropdownMenu.ItemIndicator className="dropdown-check">
                  <CheckIcon />
                </DropdownMenu.ItemIndicator>
                MapBox
              </DropdownMenu.CheckboxItem>

              <DropdownMenu.Separator className="dropdown-separator" />

              {/* Display Options */}
              <DropdownMenu.Label className="dropdown-label">Display Options</DropdownMenu.Label>
              <DropdownMenu.CheckboxItem
                className="dropdown-item"
                checked={altitudeColorsEnabled}
                onCheckedChange={setAltitudeColorsEnabled}
              >
                <DropdownMenu.ItemIndicator className="dropdown-check">
                  <CheckIcon />
                </DropdownMenu.ItemIndicator>
                Altitude Colors
              </DropdownMenu.CheckboxItem>
              {mapProvider === 'mapbox' && (
                <DropdownMenu.CheckboxItem
                  className="dropdown-item"
                  checked={is3DMode}
                  onCheckedChange={set3DMode}
                >
                  <DropdownMenu.ItemIndicator className="dropdown-check">
                    <CheckIcon />
                  </DropdownMenu.ItemIndicator>
                  3D Track
                </DropdownMenu.CheckboxItem>
              )}

              <DropdownMenu.Separator className="dropdown-separator" />

              {/* Theme */}
              <DropdownMenu.Label className="dropdown-label">Theme</DropdownMenu.Label>
              <DropdownMenu.CheckboxItem
                className="dropdown-item"
                checked={theme === 'dark'}
                onSelect={() => handleThemeChange('dark')}
              >
                <DropdownMenu.ItemIndicator className="dropdown-check">
                  <CheckIcon />
                </DropdownMenu.ItemIndicator>
                Dark
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.CheckboxItem
                className="dropdown-item"
                checked={theme === 'light'}
                onSelect={() => handleThemeChange('light')}
              >
                <DropdownMenu.ItemIndicator className="dropdown-check">
                  <CheckIcon />
                </DropdownMenu.ItemIndicator>
                Light
              </DropdownMenu.CheckboxItem>

              <DropdownMenu.Separator className="dropdown-separator" />

              {/* Sample Flights */}
              <DropdownMenu.Label className="dropdown-label">Sample Flights</DropdownMenu.Label>
              {SAMPLE_FLIGHTS.map(sample => (
                <DropdownMenu.Item
                  key={sample.id}
                  className="dropdown-item"
                  onSelect={() => handleLoadSample(sample.file)}
                >
                  {sample.name}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
