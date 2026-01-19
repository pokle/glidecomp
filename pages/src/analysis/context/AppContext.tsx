/**
 * App Context
 *
 * Shared state for the IGC analysis application.
 * Manages IGC file data, task data, events, and UI state.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { parseIGC, type IGCFile, type IGCFix } from '../igc-parser';
import { fetchTaskByCode, calculateOptimizedTaskDistance, type XCTask } from '../xctsk-parser';
import { detectFlightEvents, type FlightEvent } from '../event-detector';

export type MapProviderType = 'leaflet' | 'mapbox';
export type ViewMode = 'list' | 'both' | 'map';
export type Theme = 'dark' | 'light';

export interface FlightInfo {
  date?: string;
  pilot?: string;
  glider?: string;
  duration?: string;
  maxAlt?: string;
  task?: string;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface AppState {
  igcFile: IGCFile | null;
  task: XCTask | null;
  fixes: IGCFix[];
  events: FlightEvent[];
  viewMode: ViewMode;
  mapProvider: MapProviderType;
  theme: Theme;
  altitudeColorsEnabled: boolean;
  is3DMode: boolean;
  selectedEvent: FlightEvent | null;
  mapBounds: MapBounds | null;
  statusMessage: { text: string; variant: 'primary' | 'success' | 'warning' | 'danger' } | null;
  flightInfo: FlightInfo;
  filterVisibleEvents: boolean;
}

interface AppContextType extends AppState {
  loadIGCFile: (file: File) => Promise<void>;
  loadTask: (code: string) => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setMapProvider: (provider: MapProviderType) => void;
  setTheme: (theme: Theme) => void;
  setAltitudeColorsEnabled: (enabled: boolean) => void;
  set3DMode: (enabled: boolean) => void;
  selectEvent: (event: FlightEvent | null) => void;
  setMapBounds: (bounds: MapBounds | null) => void;
  showStatus: (text: string, variant: 'primary' | 'success' | 'warning' | 'danger') => void;
  setFilterVisibleEvents: (enabled: boolean) => void;
  getFilteredEvents: () => FlightEvent[];
}

const AppContext = createContext<AppContextType | null>(null);

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}

/**
 * Get provider type from URL query params
 */
function getProviderFromUrl(): MapProviderType {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get('m');
  if (provider === 'b') return 'mapbox';
  return 'leaflet';
}

/**
 * Get theme from localStorage
 */
function getStoredTheme(): Theme {
  const stored = localStorage.getItem('theme');
  return (stored === 'light' || stored === 'dark') ? stored : 'dark';
}

/**
 * Get altitude colors setting from URL
 */
function getAltitudeColorsFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('alt') === '1';
}

/**
 * Get 3D mode setting from URL
 */
function get3DModeFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('3d') === '1';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    igcFile: null,
    task: null,
    fixes: [],
    events: [],
    viewMode: 'both',
    mapProvider: getProviderFromUrl(),
    theme: getStoredTheme(),
    altitudeColorsEnabled: getAltitudeColorsFromUrl(),
    is3DMode: get3DModeFromUrl(),
    selectedEvent: null,
    mapBounds: null,
    statusMessage: { text: 'Ready - drop an IGC file or use the file picker', variant: 'primary' },
    flightInfo: {},
    filterVisibleEvents: true,
  });

  const showStatus = useCallback((text: string, variant: 'primary' | 'success' | 'warning' | 'danger') => {
    setState(prev => ({ ...prev, statusMessage: { text, variant } }));

    // Auto-hide success messages
    if (variant === 'success') {
      setTimeout(() => {
        setState(prev => {
          if (prev.statusMessage?.text === text) {
            return { ...prev, statusMessage: null };
          }
          return prev;
        });
      }, 3000);
    }
  }, []);

  const updateFlightInfo = useCallback((igcFile: IGCFile | null, fixes: IGCFix[], task: XCTask | null) => {
    const info: FlightInfo = {};

    if (igcFile) {
      const h = igcFile.header;
      if (h.date) info.date = h.date.toLocaleDateString();
      if (h.pilot) info.pilot = h.pilot;
      if (h.gliderType) info.glider = h.gliderType;

      if (fixes.length > 0) {
        const duration = fixes[fixes.length - 1].time.getTime() - fixes[0].time.getTime();
        const hours = Math.floor(duration / 3600000);
        const mins = Math.floor((duration % 3600000) / 60000);
        info.duration = `${hours}h ${mins}m`;

        const maxAlt = Math.max(...fixes.map(f => f.gnssAltitude));
        info.maxAlt = `${maxAlt}m`;
      }
    }

    if (task) {
      const numTurnpoints = task.turnpoints.length;
      const optimizedDistance = calculateOptimizedTaskDistance(task);
      const distanceKm = (optimizedDistance / 1000).toFixed(2);
      info.task = `${numTurnpoints} TPs, ${distanceKm} km`;
    }

    return info;
  }, []);

  const loadIGCFile = useCallback(async (file: File) => {
    showStatus('Loading IGC file...', 'primary');

    try {
      const content = await file.text();
      const igcFile = parseIGC(content);
      const fixes = igcFile.fixes;

      // Detect events with current task
      const events = detectFlightEvents(fixes, state.task || undefined);

      // Update flight info
      const flightInfo = updateFlightInfo(igcFile, fixes, state.task);

      setState(prev => ({
        ...prev,
        igcFile,
        fixes,
        events,
        flightInfo,
      }));

      showStatus(`Loaded ${file.name} - ${fixes.length} fixes`, 'success');
    } catch (err) {
      console.error('Failed to parse IGC file:', err);
      showStatus(`Failed to parse IGC file: ${err}`, 'danger');
    }
  }, [state.task, showStatus, updateFlightInfo]);

  const loadTask = useCallback(async (code: string) => {
    showStatus(`Loading task ${code}...`, 'primary');

    try {
      const task = await fetchTaskByCode(code);

      // Re-detect events with new task
      const events = state.fixes.length > 0
        ? detectFlightEvents(state.fixes, task)
        : [];

      // Update flight info
      const flightInfo = updateFlightInfo(state.igcFile, state.fixes, task);

      setState(prev => ({
        ...prev,
        task,
        events,
        flightInfo,
      }));

      showStatus(`Loaded task: ${task.turnpoints.length} turnpoints`, 'success');
    } catch (err) {
      console.error('Failed to load task:', err);
      showStatus(`Failed to load task: ${err}`, 'danger');
    }
  }, [state.fixes, state.igcFile, showStatus, updateFlightInfo]);

  const setViewMode = useCallback((mode: ViewMode) => {
    setState(prev => ({ ...prev, viewMode: mode }));
  }, []);

  const setMapProvider = useCallback((provider: MapProviderType) => {
    // Update URL and reload
    const params = new URLSearchParams(window.location.search);
    params.set('m', provider === 'mapbox' ? 'b' : 'l');
    window.location.search = params.toString();
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    localStorage.setItem('theme', theme);
    setState(prev => ({ ...prev, theme }));
  }, []);

  const setAltitudeColorsEnabled = useCallback((enabled: boolean) => {
    setState(prev => ({ ...prev, altitudeColorsEnabled: enabled }));

    // Update URL
    const params = new URLSearchParams(window.location.search);
    if (enabled) {
      params.set('alt', '1');
    } else {
      params.delete('alt');
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }, []);

  const set3DMode = useCallback((enabled: boolean) => {
    setState(prev => ({ ...prev, is3DMode: enabled }));

    // Update URL
    const params = new URLSearchParams(window.location.search);
    if (enabled) {
      params.set('3d', '1');
    } else {
      params.delete('3d');
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }, []);

  const selectEvent = useCallback((event: FlightEvent | null) => {
    setState(prev => ({ ...prev, selectedEvent: event }));
  }, []);

  const setMapBounds = useCallback((bounds: MapBounds | null) => {
    setState(prev => ({ ...prev, mapBounds: bounds }));
  }, []);

  const setFilterVisibleEvents = useCallback((enabled: boolean) => {
    setState(prev => ({ ...prev, filterVisibleEvents: enabled }));
  }, []);

  const getFilteredEvents = useCallback(() => {
    if (!state.filterVisibleEvents || !state.mapBounds) {
      return state.events;
    }

    const bounds = state.mapBounds;
    return state.events.filter(event =>
      event.latitude >= bounds.south &&
      event.latitude <= bounds.north &&
      event.longitude >= bounds.west &&
      event.longitude <= bounds.east
    );
  }, [state.events, state.mapBounds, state.filterVisibleEvents]);

  const value: AppContextType = {
    ...state,
    loadIGCFile,
    loadTask,
    setViewMode,
    setMapProvider,
    setTheme,
    setAltitudeColorsEnabled,
    set3DMode,
    selectEvent,
    setMapBounds,
    showStatus,
    setFilterVisibleEvents,
    getFilteredEvents,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}
