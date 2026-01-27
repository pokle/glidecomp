/**
 * IGC Analysis Tool - Main Entry Point
 *
 * Wires together all components:
 * - File upload handling
 * - Task code fetching
 * - Map rendering
 * - Event detection and display
 */

import { parseIGC, IGCFile, IGCFix } from './igc-parser';
import { fetchTaskByCode, XCTask, calculateOptimizedTaskDistance, igcTaskToXCTask } from './xctsk-parser';
import { createMapProvider, MapProvider } from './map-provider';
import { detectFlightEvents, FlightEvent } from './event-detector';
import { createEventPanel, EventPanel, FlightInfo } from './event-panel';
import { loadCorryongWaypoints, type WaypointRecord } from './waypoints';
import { config, type UnitPreferences } from './config';
import { formatAltitude, formatDistance, onUnitsChanged } from './units';

// Import styles
import '../styles.css';

interface AppState {
  igcFile: IGCFile | null;
  task: XCTask | null;
  fixes: IGCFix[];
  events: FlightEvent[];
}

const state: AppState = {
  igcFile: null,
  task: null,
  fixes: [],
  events: [],
};

let mapRenderer: MapProvider | null = null;
let eventPanel: EventPanel | null = null;
let waypointDatabase: WaypointRecord[] = [];

// Feature states
let isAltitudeColorsEnabled = false;
let is3DTrackEnabled = false;
let isTaskVisible = true;
let isTrackVisible = true;

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  const mapContainer = document.getElementById('map');
  const eventPanelContainer = document.getElementById('event-panel-container');
  const igcFileInput = document.getElementById('igc-file') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const commandDialog = document.getElementById('command-dialog') as HTMLDialogElement | null;
  const importTaskDialog = document.getElementById('import-task-dialog') as HTMLDialogElement | null;
  const importTaskInput = document.getElementById('import-task-input') as HTMLInputElement | null;

  // Menu items
  const menuOpenIgc = document.getElementById('menu-open-igc');
  const menuImportTask = document.getElementById('menu-import-task');
  const menuAltitudeColors = document.getElementById('menu-altitude-colors');
  const menu3DTrack = document.getElementById('menu-3d-track');
  const menuToggleTask = document.getElementById('menu-toggle-task');
  const menuToggleTrack = document.getElementById('menu-toggle-track');
  const menuThemeLight = document.getElementById('menu-theme-light');
  const menuThemeDark = document.getElementById('menu-theme-dark');
  const menuThemeSystem = document.getElementById('menu-theme-system');
  const altitudeColorsStatus = document.getElementById('altitude-colors-status');
  const threeDTrackStatus = document.getElementById('3d-track-status');
  const taskVisibilityStatus = document.getElementById('task-visibility-status');
  const trackVisibilityStatus = document.getElementById('track-visibility-status');

  // Units dialog
  const menuConfigureUnits = document.getElementById('menu-configure-units');
  const unitsDialog = document.getElementById('units-dialog') as HTMLDialogElement | null;
  const unitsForm = document.getElementById('units-form') as HTMLFormElement | null;
  const unitSpeedSelect = document.getElementById('unit-speed-select') as HTMLSelectElement | null;
  const unitAltitudeSelect = document.getElementById('unit-altitude-select') as HTMLSelectElement | null;
  const unitDistanceSelect = document.getElementById('unit-distance-select') as HTMLSelectElement | null;
  const unitClimbRateSelect = document.getElementById('unit-climbrate-select') as HTMLSelectElement | null;

  // Sidebar elements
  const sidebar = document.getElementById('waypoint-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Initialize map with MapBox provider
  try {
    mapRenderer = await createMapProvider(mapContainer);
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Load waypoint database for enriching IGC tasks
  try {
    waypointDatabase = await loadCorryongWaypoints();
    console.log(`Loaded ${waypointDatabase.length} waypoints`);
  } catch (err) {
    console.warn('Failed to load waypoint database:', err);
  }

  // Load feature states from URL params
  const params = new URLSearchParams(window.location.search);

  // Set up altitude colors toggle
  if (mapRenderer.supportsAltitudeColors && menuAltitudeColors) {
    isAltitudeColorsEnabled = params.get('alt') !== '0';
    updateFeatureStatus(altitudeColorsStatus, isAltitudeColorsEnabled);

    if (isAltitudeColorsEnabled && mapRenderer.setAltitudeColors) {
      mapRenderer.setAltitudeColors(true);
    }

    menuAltitudeColors.addEventListener('click', () => {
      isAltitudeColorsEnabled = !isAltitudeColorsEnabled;
      updateFeatureStatus(altitudeColorsStatus, isAltitudeColorsEnabled);

      if (mapRenderer?.setAltitudeColors) {
        mapRenderer.setAltitudeColors(isAltitudeColorsEnabled);
        updateUrlParam('alt', isAltitudeColorsEnabled ? null : '0');
      }

      // Clear event panel selection since map highlights are cleared
      eventPanel?.clearSelection();

      // Close the command dialog
      commandDialog?.close();
    });
  } else if (menuAltitudeColors) {
    menuAltitudeColors.style.display = 'none';
  }

  // Set up 3D toggle
  if (mapRenderer.supports3D && menu3DTrack) {
    is3DTrackEnabled = params.get('3d') === '1';
    updateFeatureStatus(threeDTrackStatus, is3DTrackEnabled);

    if (is3DTrackEnabled && mapRenderer.set3DMode) {
      mapRenderer.set3DMode(true);
    }

    menu3DTrack.addEventListener('click', () => {
      is3DTrackEnabled = !is3DTrackEnabled;
      updateFeatureStatus(threeDTrackStatus, is3DTrackEnabled);

      if (mapRenderer?.set3DMode) {
        mapRenderer.set3DMode(is3DTrackEnabled);
        updateUrlParam('3d', is3DTrackEnabled ? '1' : null);
      }

      // Clear event panel selection since map highlights are cleared
      eventPanel?.clearSelection();

      // Close the command dialog
      commandDialog?.close();
    });
  } else if (menu3DTrack) {
    menu3DTrack.style.display = 'none';
  }

  // Set up task visibility toggle
  if (menuToggleTask) {
    isTaskVisible = params.get('task-visible') !== '0';
    updateFeatureStatus(taskVisibilityStatus, isTaskVisible);

    if (!isTaskVisible && mapRenderer?.setTaskVisibility) {
      mapRenderer.setTaskVisibility(false);
    }

    menuToggleTask.addEventListener('click', () => {
      isTaskVisible = !isTaskVisible;
      updateFeatureStatus(taskVisibilityStatus, isTaskVisible);

      if (mapRenderer?.setTaskVisibility) {
        mapRenderer.setTaskVisibility(isTaskVisible);
        updateUrlParam('task-visible', isTaskVisible ? null : '0');
      }

      // Close the command dialog
      commandDialog?.close();
    });
  }

  // Set up track visibility toggle
  if (menuToggleTrack) {
    isTrackVisible = params.get('track-visible') !== '0';
    updateFeatureStatus(trackVisibilityStatus, isTrackVisible);

    if (!isTrackVisible && mapRenderer?.setTrackVisibility) {
      mapRenderer.setTrackVisibility(false);
    }

    menuToggleTrack.addEventListener('click', () => {
      isTrackVisible = !isTrackVisible;
      updateFeatureStatus(trackVisibilityStatus, isTrackVisible);

      if (mapRenderer?.setTrackVisibility) {
        mapRenderer.setTrackVisibility(isTrackVisible);
        updateUrlParam('track-visible', isTrackVisible ? null : '0');
      }

      // Clear event panel selection when hiding track
      if (!isTrackVisible) {
        eventPanel?.clearSelection();
      }

      // Close the command dialog
      commandDialog?.close();
    });
  }

  // Theme switching handlers
  const setTheme = (mode: 'light' | 'dark' | 'system') => {
    if (mode === 'system') {
      localStorage.removeItem('themeMode');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
    } else {
      localStorage.setItem('themeMode', mode);
      document.documentElement.classList.toggle('dark', mode === 'dark');
    }
    commandDialog?.close();
  };

  menuThemeLight?.addEventListener('click', () => setTheme('light'));
  menuThemeDark?.addEventListener('click', () => setTheme('dark'));
  menuThemeSystem?.addEventListener('click', () => setTheme('system'));

  // Listen for system theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('themeMode')) {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });

  // Units dialog handlers
  const populateUnitsDialog = () => {
    const units = config.getUnits();
    if (unitSpeedSelect) unitSpeedSelect.value = units.speed;
    if (unitAltitudeSelect) unitAltitudeSelect.value = units.altitude;
    if (unitDistanceSelect) unitDistanceSelect.value = units.distance;
    if (unitClimbRateSelect) unitClimbRateSelect.value = units.climbRate;
  };

  // Open units dialog
  menuConfigureUnits?.addEventListener('click', () => {
    commandDialog?.close();
    populateUnitsDialog();
    unitsDialog?.showModal();
  });

  // Handle units form submission
  unitsForm?.addEventListener('submit', (e) => {
    e.preventDefault();

    const newUnits: Partial<UnitPreferences> = {};
    if (unitSpeedSelect) newUnits.speed = unitSpeedSelect.value as UnitPreferences['speed'];
    if (unitAltitudeSelect) newUnits.altitude = unitAltitudeSelect.value as UnitPreferences['altitude'];
    if (unitDistanceSelect) newUnits.distance = unitDistanceSelect.value as UnitPreferences['distance'];
    if (unitClimbRateSelect) newUnits.climbRate = unitClimbRateSelect.value as UnitPreferences['climbRate'];

    config.setPreferences({ units: newUnits as UnitPreferences });
    unitsDialog?.close();
  });

  // Subscribe to unit changes for reactive updates
  onUnitsChanged(() => {
    // Re-detect events to regenerate descriptions with new units
    if (state.fixes.length > 0) {
      state.events = detectFlightEvents(state.fixes, state.task || undefined);
      eventPanel?.setEvents(state.events);
      mapRenderer?.setEvents(state.events);
    }

    updateFlightInfo();

    // Re-render map task labels with new units
    if (state.task && mapRenderer) {
      mapRenderer.setTask(state.task);
    }
  });

  // Set up sidebar toggle for mobile
  if (sidebar && sidebarBackdrop) {
    // Listen for Basecoat sidebar events
    document.addEventListener('basecoat:sidebar', ((e: CustomEvent) => {
      const detail = e.detail || {};

      if (detail.id && detail.id !== 'waypoint-sidebar') return;

      const isOpen = sidebar.getAttribute('aria-hidden') === 'false';

      if (detail.action === 'close' || (detail.action === undefined && isOpen)) {
        sidebar.setAttribute('aria-hidden', 'true');
        sidebar.classList.add('translate-x-full');
        sidebarBackdrop.classList.add('hidden');
      } else {
        sidebar.setAttribute('aria-hidden', 'false');
        sidebar.classList.remove('translate-x-full');
        sidebarBackdrop.classList.remove('hidden');
      }
    }) as EventListener);
  }

  // Handle event click
  const handleEventClick = (event: FlightEvent, options?: { skipPan?: boolean }) => {
    if (mapRenderer) {
      mapRenderer.panToEvent(event, options);
    }

    // Close sidebar on mobile after selecting an event
    if (window.innerWidth < 768 && sidebar) {
      document.dispatchEvent(new CustomEvent('basecoat:sidebar', { detail: { action: 'close', id: 'waypoint-sidebar' } }));
    }
  };

  // Handle panel toggle
  const handlePanelToggle = () => {
    if (mapRenderer) {
      mapRenderer.invalidateSize();
    }
  };

  // Initialize event panel
  eventPanel = createEventPanel({
    container: eventPanelContainer,
    onEventClick: handleEventClick,
    onToggle: handlePanelToggle,
  });

  // Register track click handler to select events when clicking on the track
  mapRenderer.onTrackClick?.((fixIndex: number) => {
    // Open event panel if closed
    eventPanel?.open();

    // Select the event for this fix (skip panning since user clicked directly on the track)
    eventPanel?.selectByFixIndex(fixIndex, { skipPan: true });
  });

  // Open IGC menu item triggers hidden file input
  menuOpenIgc?.addEventListener('click', () => {
    commandDialog?.close();
    igcFileInput?.click();
  });

  // File input handler
  igcFileInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      await loadIGCFile(file);
    }
  });

  // Drag and drop handlers
  if (dropZone) {
    // Enable drag and drop on the map container
    const mapContainerEl = mapContainer.parentElement;

    mapContainerEl?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    mapContainerEl?.addEventListener('dragleave', (e) => {
      // Only hide if leaving the container entirely
      if (e.relatedTarget && mapContainerEl.contains(e.relatedTarget as Node)) {
        return;
      }
      dropZone.classList.remove('drag-over');
    });

    mapContainerEl?.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');

      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.igc')) {
        await loadIGCFile(file);
      } else {
        showStatus('Please drop an IGC file', 'warning');
      }
    });
  }

  // Import task menu item -> opens import dialog
  menuImportTask?.addEventListener('click', () => {
    commandDialog?.close();
    if (importTaskInput) {
      importTaskInput.value = '';
    }
    importTaskDialog?.showModal();
    importTaskInput?.focus();
  });

  // Import task dialog input handler
  importTaskInput?.addEventListener('keydown', async (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter') {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const code = importTaskInput.value.trim();
      if (code) {
        importTaskDialog?.close();
        await loadTask(code);
      }
    } else if (keyEvent.key === 'Escape') {
      importTaskDialog?.close();
    }
  });

  // Keyboard shortcut for command menu (Cmd/Ctrl + K)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (commandDialog?.open) {
        commandDialog.close();
      } else {
        commandDialog?.showModal();
      }
    }
  });

  /**
   * Load and parse an IGC file
   */
  async function loadIGCFile(file: File): Promise<void> {
    showStatus('Loading IGC file...', 'info');

    try {
      const content = await file.text();
      const igcFile = parseIGC(content);

      state.igcFile = igcFile;
      state.fixes = igcFile.fixes;

      // Update map
      if (mapRenderer) {
        mapRenderer.setTrack(igcFile.fixes);
      }

      // If IGC file has a declared task and no external task is loaded, use it
      if (igcFile.task && igcFile.task.start && !state.task) {
        const xcTask = igcTaskToXCTask(igcFile.task, { waypoints: waypointDatabase });
        state.task = xcTask;

        if (mapRenderer) {
          await mapRenderer.setTask(xcTask);
        }
      }

      // Detect events
      state.events = detectFlightEvents(igcFile.fixes, state.task || undefined);

      // Update event panel
      eventPanel?.setEvents(state.events);

      // Update map events
      if (mapRenderer) {
        mapRenderer.setEvents(state.events);
      }

      // Update flight info
      updateFlightInfo();

      const taskInfo = igcFile.task?.start ? ' (with task declaration)' : '';
      showStatus(`Loaded ${file.name} - ${igcFile.fixes.length} fixes${taskInfo}`, 'success');
    } catch (err) {
      console.error('Failed to parse IGC file:', err);
      showStatus(`Failed to parse IGC file: ${err}`, 'error');
    }
  }

  /**
   * Load task by code
   */
  async function loadTask(code: string): Promise<void> {
    showStatus(`Loading task ${code}...`, 'info');

    try {
      const task = await fetchTaskByCode(code);
      state.task = task;

      // Update map
      if (mapRenderer) {
        mapRenderer.setTask(task);
      }

      // Re-detect events with task
      if (state.fixes.length > 0) {
        state.events = detectFlightEvents(state.fixes, task);

        eventPanel?.setEvents(state.events);

        if (mapRenderer) {
          mapRenderer.setEvents(state.events);
        }
      }

      // Update flight info
      updateFlightInfo();

      showStatus(`Loaded task: ${task.turnpoints.length} turnpoints`, 'success');
    } catch (err) {
      console.error('Failed to load task:', err);
      showStatus(`Failed to load task: ${err}`, 'error');
    }
  }

  /**
   * Update flight info display
   */
  function updateFlightInfo(): void {
    const info: FlightInfo = {};

    if (state.igcFile) {
      const h = state.igcFile.header;

      if (h.date) {
        info.date = h.date.toLocaleDateString();
      }

      if (h.pilot) {
        info.pilot = h.pilot;
      }

      if (h.gliderType) {
        info.glider = h.gliderType;
      }

      if (state.fixes.length > 0) {
        const duration = state.fixes[state.fixes.length - 1].time.getTime() -
          state.fixes[0].time.getTime();
        const hours = Math.floor(duration / 3600000);
        const mins = Math.floor((duration % 3600000) / 60000);
        info.duration = `${hours}h ${mins}m`;

        const maxAlt = Math.max(...state.fixes.map(f => f.gnssAltitude));
        info.maxAlt = formatAltitude(maxAlt).withUnit;
      }
    }

    if (state.task) {
      const numTurnpoints = state.task.turnpoints.length;
      const optimizedDistance = calculateOptimizedTaskDistance(state.task);
      const distanceFormatted = formatDistance(optimizedDistance);
      info.task = `${numTurnpoints} TPs, ${distanceFormatted.withUnit}`;
    }

    eventPanel?.setFlightInfo(info);
  }

  /**
   * Show status message
   */
  function showStatus(message: string, variant: 'info' | 'success' | 'warning' | 'error'): void {
    const statusEl = document.getElementById('status');
    const statusMessageEl = document.getElementById('status-message');

    if (!statusEl || !statusMessageEl) return;

    statusMessageEl.textContent = message;

    // Update alert styling based on variant
    statusEl.classList.remove('hidden', 'alert-info', 'alert-success', 'alert-warning', 'alert-destructive');

    const variantClasses: Record<string, string> = {
      info: '',
      success: 'alert-success',
      warning: 'alert-warning',
      error: 'alert-destructive',
    };

    if (variantClasses[variant]) {
      statusEl.classList.add(variantClasses[variant]);
    }

    // Auto-hide for success messages
    if (variant === 'success') {
      setTimeout(() => {
        statusEl.classList.add('hidden');
      }, 3000);
    }
  }

  /**
   * Update URL parameter without reloading
   */
  function updateUrlParam(key: string, value: string | null): void {
    const params = new URLSearchParams(window.location.search);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }

  /**
   * Update feature status text in command menu
   */
  function updateFeatureStatus(element: HTMLElement | null, enabled: boolean): void {
    if (element) {
      element.textContent = enabled ? '(on)' : '(off)';
    }
  }

  // Sample flights
  const sampleFiles: Record<string, string> = {
    'sample-rohan': '2026-01-05-RohanHolt-XFH-000-01.IGC',
    'sample-shane': '2026-01-05-shane-dunc-XCT-SDU-02.igc',
    'sample-gordon': '20260105-132715-GordonRigg.999.igc',
    'sample-burkitt': 'burkitt_18393_050126.igc',
    'sample-durand': 'durand_45515_050126.igc',
    'sample-holtkamp': 'holtkamp_33915_050126.igc',
    'sample-tushar': '2025-01-05-Tushar-Corryong.igc'
  };

  const loadSampleFile = async (filename: string) => {
    try {
      const response = await fetch(`/data/tracks/${filename}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const content = await response.text();
      const file = new File([content], filename, { type: 'text/plain' });
      await loadIGCFile(file);

      // Close the command dialog
      commandDialog?.close();
    } catch (err) {
      console.error('Failed to load sample file:', err);
      showStatus(`Failed to load sample: ${err}`, 'error');
    }
  };

  Object.entries(sampleFiles).forEach(([id, filename]) => {
    document.getElementById(id)?.addEventListener('click', () => loadSampleFile(filename));
  });

  showStatus('Ready - drop an IGC file or use the file picker', 'info');

  // Load from query params if present (e.g., ?task=buje&track=sample.igc)
  await loadFromQueryParams(loadTask, loadIGCFile);
}

/**
 * Parse URL query parameters and load task/track if specified
 */
async function loadFromQueryParams(
  loadTask: (code: string) => Promise<void>,
  loadIGCFile: (file: File) => Promise<void>
): Promise<void> {
  const params = new URLSearchParams(window.location.search);

  const taskCode = params.get('task');
  const trackFile = params.get('track');

  // Load task first if specified
  if (taskCode) {
    await loadTask(taskCode);
  }

  // Load track from samples folder if specified
  if (trackFile) {
    // Security: validate filename to prevent directory traversal
    const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+\.igc$/i;

    if (!safeFilenamePattern.test(trackFile) || trackFile.includes('..')) {
      console.error('Invalid track filename:', trackFile);
      return;
    }

    try {
      const response = await fetch(`/data/tracks/${trackFile}`);
      if (!response.ok) {
        console.error(`Failed to fetch track: ${response.status}`);
        return;
      }

      const content = await response.text();
      const file = new File([content], trackFile, { type: 'text/plain' });
      await loadIGCFile(file);
    } catch (err) {
      console.error('Failed to load track from URL:', err);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
