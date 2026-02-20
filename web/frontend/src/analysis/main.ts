/**
 * IGC Analysis Tool - Main Entry Point
 *
 * Wires together all components:
 * - File upload handling
 * - Task code fetching
 * - Map rendering
 * - Event detection and display
 */

import { parseIGC, parseXCTask, detectFlightEvents, calculateOptimizedTaskDistance, igcTaskToXCTask, resolveTurnpointSequence, type IGCFile, type IGCFix, type XCTask, type FlightEvent, type WaypointRecord } from '@taskscore/analysis';
import { fetchTaskByCodeWithRaw } from './xctsk-fetch';
import { createMapProvider, type MapProvider, type MapProviderType } from './map-provider';
import { createAnalysisPanel, AnalysisPanel, FlightInfo } from './analysis-panel';
import { loadCorryongWaypoints } from './waypoint-loader';
import { config, type UnitPreferences } from './config';
import { formatAltitude, formatDistance, onUnitsChanged } from './units-browser';
import { storage } from './storage';
import { StorageMenu } from './storage-menu';
import { fetchAirScoreTask, fetchAirScoreTrack } from './airscore-client';

// Import styles
import '../styles.css';

// Basecoat JS for interactive components
import "@pokle/basecoat-css/basecoat.min";
import "@pokle/basecoat-css/dropdown-menu.min";
import "@pokle/basecoat-css/command.min";
import "@pokle/basecoat-css/sidebar.min";

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
let analysisPanel: AnalysisPanel | null = null;
let storageMenu: StorageMenu | null = null;
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
  const importAirscoreDialog = document.getElementById('import-airscore-dialog') as HTMLDialogElement | null;
  const importAirscoreInput = document.getElementById('import-airscore-input') as HTMLInputElement | null;

  // Menu items
  const menuFeedback = document.getElementById('menu-feedback');
  const menuOpenIgc = document.getElementById('menu-open-igc');
  const menuImportTask = document.getElementById('menu-import-task');
  const menuImportAirscore = document.getElementById('menu-import-airscore');
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
  const menuClearSession = document.getElementById('menu-clear-session');
  const unitsDialog = document.getElementById('units-dialog') as HTMLDialogElement | null;
  const unitsForm = document.getElementById('units-form') as HTMLFormElement | null;
  const unitSpeedSelect = document.getElementById('unit-speed-select') as HTMLSelectElement | null;
  const unitAltitudeSelect = document.getElementById('unit-altitude-select') as HTMLSelectElement | null;
  const unitDistanceSelect = document.getElementById('unit-distance-select') as HTMLSelectElement | null;
  const unitClimbRateSelect = document.getElementById('unit-climbrate-select') as HTMLSelectElement | null;

  // Sidebar elements
  const sidebar = document.getElementById('waypoint-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  // Map provider switch menu
  const menuSwitchMap = document.getElementById('menu-switch-map');
  const mapProviderLabel = document.getElementById('map-provider-label');

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Determine map provider: URL param > saved preference > default
  const mapParam = new URLSearchParams(window.location.search).get('m');
  const savedMapProvider = config.getPreferences().mapProvider;
  const providerType: MapProviderType =
    mapParam === 'l' ? 'leaflet' :
    mapParam === 'm' ? 'mapbox' :
    savedMapProvider ?? 'mapbox';

  // Initialize map
  try {
    mapRenderer = await createMapProvider(mapContainer, providerType);
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Update provider label in command menu to show the target provider
  if (mapProviderLabel) {
    const targetProvider = providerType === 'leaflet' ? 'MapBox' : 'Leaflet';
    mapProviderLabel.textContent = `Switch Map Provider to ${targetProvider}`;
  }

  // Load waypoint database for enriching IGC tasks
  try {
    waypointDatabase = await loadCorryongWaypoints();
    console.log(`Loaded ${waypointDatabase.length} waypoints`);
  } catch (err) {
    console.warn('Failed to load waypoint database:', err);
  }

  // Initialize storage and menu
  try {
    await storage.init();
    storageMenu = new StorageMenu({
      onTaskSelect: async (taskId) => {
        commandDialog?.close();
        await loadStoredTask(taskId);
      },
      onTrackSelect: async (trackId) => {
        commandDialog?.close();
        await loadStoredTrack(trackId);
      },
    });
    storageMenu.init();
    await storageMenu.refresh();
  } catch (err) {
    console.warn('Failed to initialize storage:', err);
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

      // Clear analysis panel selection since map highlights are cleared
      analysisPanel?.clearSelection();

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

      // Clear analysis panel selection since map highlights are cleared
      analysisPanel?.clearSelection();

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

      // Clear analysis panel selection when hiding track
      if (!isTrackVisible) {
        analysisPanel?.clearSelection();
      }

      // Close the command dialog
      commandDialog?.close();
    });
  }

  // Switch Map Provider handler
  menuSwitchMap?.addEventListener('click', () => {
    const newProvider: MapProviderType = providerType === 'mapbox' ? 'leaflet' : 'mapbox';
    config.setPreferences({ mapProvider: newProvider });

    // Update URL param and reload (provider switch requires full page reload)
    const params = new URLSearchParams(window.location.search);
    params.set('m', newProvider === 'leaflet' ? 'l' : 'm');
    window.location.search = params.toString();
  });

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

  // Clear current task and track (reset to initial state)
  menuClearSession?.addEventListener('click', () => {
    commandDialog?.close();

    // Clear state
    state.igcFile = null;
    state.task = null;
    state.fixes = [];
    state.events = [];

    // Clear map
    if (mapRenderer) {
      mapRenderer.clearTrack();
      mapRenderer.clearTask();
      mapRenderer.clearEvents();
    }

    // Clear analysis panel
    analysisPanel?.setEvents([]);
    analysisPanel?.setAltitudes([]);
    analysisPanel?.setFlightInfo({});
    analysisPanel?.setTask(null);
    analysisPanel?.setScore(null);
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
      analysisPanel?.setEvents(state.events);
      mapRenderer?.setEvents(state.events);
    }

    updateFlightInfo();
    updateScore();

    // Re-render map task labels with new units
    if (state.task && mapRenderer) {
      mapRenderer.setTask(state.task);
      analysisPanel?.setTask(state.task);
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

  // Handle turnpoint click from panel - pan map to turnpoint center
  const handleTurnpointClick = (turnpointIndex: number) => {
    if (mapRenderer?.panToTurnpoint) {
      mapRenderer.panToTurnpoint(turnpointIndex);
    }

    // Close sidebar on mobile after selecting a turnpoint
    if (window.innerWidth < 768 && sidebar) {
      document.dispatchEvent(new CustomEvent('basecoat:sidebar', { detail: { action: 'close', id: 'waypoint-sidebar' } }));
    }
  };

  // Initialize analysis panel with hide/show callbacks for sidebar visibility
  analysisPanel = createAnalysisPanel({
    container: eventPanelContainer,
    onEventClick: handleEventClick,
    onTurnpointClick: handleTurnpointClick,
    onToggle: handlePanelToggle,
    onHide: () => {
      if (sidebar) {
        sidebar.setAttribute('aria-hidden', 'true');
        sidebar.classList.add('translate-x-full');
        sidebarBackdrop?.classList.add('hidden');
      }
    },
    onShow: () => {
      if (sidebar) {
        sidebar.setAttribute('aria-hidden', 'false');
        sidebar.classList.remove('translate-x-full');
        // Only show backdrop on mobile
        if (window.innerWidth < 768) {
          sidebarBackdrop?.classList.remove('hidden');
        }
      }
    },
  });

  // Show panel by default on desktop; stays hidden on mobile
  if (window.innerWidth >= 768) {
    analysisPanel.show();
  }

  // Set up header panel toggle
  const headerPanelToggle = document.getElementById('header-panel-toggle');
  headerPanelToggle?.addEventListener('click', () => {
    if (analysisPanel?.isHidden()) {
      analysisPanel.show();
    } else {
      analysisPanel?.hide();
    }
  });

  // Register track click handler to select events when clicking on the track
  mapRenderer.onTrackClick?.((fixIndex: number) => {
    // Debug: show clicked fix details before any segment lookup
    if (state.fixes.length > 0 && fixIndex >= 0 && fixIndex < state.fixes.length) {
      const fix = state.fixes[fixIndex];
      const time = fix.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const alt = formatAltitude(fix.gnssAltitude).withUnit;
      const inThermal = state.events.some(e => e.type === 'thermal_entry' && e.segment && fixIndex >= e.segment.startIndex && fixIndex <= e.segment.endIndex);
      const inGlide = state.events.some(e => e.type === 'glide_start' && e.segment && fixIndex >= e.segment.startIndex && fixIndex <= e.segment.endIndex);
      const segType = inThermal ? 'THERMAL' : inGlide ? 'GLIDE' : 'gap (no segment)';
      console.log(`[track-click] fix #${fixIndex}  ${time}  ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}  alt ${alt}  → ${segType}`);
    }

    if (analysisPanel?.isHidden()) {
      analysisPanel.show();
    }
    analysisPanel?.selectByFixIndex(fixIndex, { skipPan: true });
  });

  // Register turnpoint click handler to open Task tab when clicking on a turnpoint on the map
  mapRenderer.onTurnpointClick?.((turnpointIndex: number) => {
    if (analysisPanel?.isHidden()) {
      analysisPanel.show();
    }
    analysisPanel?.selectTurnpoint(turnpointIndex);
  });

  // Feedback menu item opens mailto link
  menuFeedback?.addEventListener('click', () => {
    commandDialog?.close();
    window.location.href = 'mailto:tushar.pokle@gmail.com?subject=TaskScore%20Feedback%20for%20you';
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

  // Import AirScore menu item -> opens AirScore dialog
  menuImportAirscore?.addEventListener('click', () => {
    commandDialog?.close();
    if (importAirscoreInput) {
      importAirscoreInput.value = '';
    }
    importAirscoreDialog?.showModal();
    importAirscoreInput?.focus();
  });

  // Import AirScore dialog input handler
  importAirscoreInput?.addEventListener('keydown', async (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter') {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const url = importAirscoreInput.value.trim();
      if (url) {
        importAirscoreDialog?.close();
        await loadAirScoreFromUrl(url);
      }
    } else if (keyEvent.key === 'Escape') {
      importAirscoreDialog?.close();
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
      await loadIGCContent(content, file.name, true);
    } catch (err) {
      console.error('Failed to parse IGC file:', err);
      showStatus(`Failed to parse IGC file: ${err}`, 'error');
    }
  }

  /**
   * Load IGC content (from file or storage)
   * @param shouldStore - whether to store in browser storage (true for new files, false for loading from storage)
   */
  async function loadIGCContent(content: string, filename: string, shouldStore: boolean): Promise<void> {
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

    // Update analysis panel
    analysisPanel?.setEvents(state.events);
    analysisPanel?.setAltitudes(igcFile.fixes.map(f => f.gnssAltitude), igcFile.fixes.map(f => f.time));
    if (state.task) {
      analysisPanel?.setTask(state.task);
    }

    // Update map events
    if (mapRenderer) {
      mapRenderer.setEvents(state.events);
    }

    // Update flight info and score
    updateFlightInfo();
    updateScore();

    // Store for future use
    if (shouldStore) {
      try {
        await storage.storeTrack(filename, content, igcFile);
        await storageMenu?.refresh();
      } catch (err) {
        console.warn('Failed to store track:', err);
      }
    }

    const taskInfo = igcFile.task?.start ? ' (with task declaration)' : '';
    showStatus(`Loaded ${filename} - ${igcFile.fixes.length} fixes${taskInfo}`, 'success');
  }

  /**
   * Load a stored track by ID
   */
  async function loadStoredTrack(id: string): Promise<void> {
    showStatus('Loading stored track...', 'info');

    try {
      const stored = await storage.getTrack(id);
      if (!stored) {
        showStatus('Track not found in storage', 'error');
        return;
      }

      await storage.touchTrack(id);
      await loadIGCContent(stored.content, stored.filename, false);
    } catch (err) {
      console.error('Failed to load stored track:', err);
      showStatus(`Failed to load stored track: ${err}`, 'error');
    }
  }

  /**
   * Load task by code
   */
  async function loadTask(code: string): Promise<void> {
    showStatus(`Loading task ${code}...`, 'info');

    try {
      // Check storage first
      const stored = await storage.getTask(code);
      let task: XCTask;

      if (stored) {
        task = stored.task;
        await storage.touchTask(code);
      } else {
        // Fetch from XContest
        const result = await fetchTaskByCodeWithRaw(code);
        task = result.task;

        // Store for future use
        try {
          await storage.storeTask(code, task, result.rawJson);
          await storageMenu?.refresh();
        } catch (err) {
          console.warn('Failed to store task:', err);
        }
      }

      state.task = task;

      // Update map
      if (mapRenderer) {
        mapRenderer.setTask(task);
      }

      // Update analysis panel with task
      analysisPanel?.setTask(task);

      // Re-detect events with task
      if (state.fixes.length > 0) {
        state.events = detectFlightEvents(state.fixes, task);

        analysisPanel?.setEvents(state.events);

        if (mapRenderer) {
          mapRenderer.setEvents(state.events);
        }
      }

      // Update flight info and score
      updateFlightInfo();
      updateScore();

      showStatus(`Loaded task: ${task.turnpoints.length} turnpoints`, 'success');
    } catch (err) {
      console.error('Failed to load task:', err);
      showStatus(`Failed to load task: ${err}`, 'error');
    }
  }

  /**
   * Load a stored task by ID (code)
   */
  async function loadStoredTask(code: string): Promise<void> {
    showStatus(`Loading stored task ${code}...`, 'info');

    try {
      const stored = await storage.getTask(code);
      if (!stored) {
        showStatus('Task not found in storage', 'error');
        return;
      }

      await storage.touchTask(code);
      state.task = stored.task;

      // Update map
      if (mapRenderer) {
        mapRenderer.setTask(stored.task);
      }

      // Update analysis panel with task
      analysisPanel?.setTask(stored.task);

      // Re-detect events with task
      if (state.fixes.length > 0) {
        state.events = detectFlightEvents(state.fixes, stored.task);

        analysisPanel?.setEvents(state.events);

        if (mapRenderer) {
          mapRenderer.setEvents(state.events);
        }
      }

      // Update flight info and score
      updateFlightInfo();
      updateScore();

      showStatus(`Loaded task: ${stored.task.turnpoints.length} turnpoints`, 'success');
    } catch (err) {
      console.error('Failed to load stored task:', err);
      showStatus(`Failed to load stored task: ${err}`, 'error');
    }
  }

  /**
   * Parse AirScore URL and extract parameters
   * Supports URLs like: https://xc.highcloud.net/tracklog_map.html?trackid=43826&comPk=466&tasPk=2030
   */
  function parseAirScoreUrl(url: string): { trackId: string; comPk: number; tasPk: number } | null {
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;

      const trackId = params.get('trackid') || params.get('trackId');
      const comPk = params.get('comPk') || params.get('compk');
      const tasPk = params.get('tasPk') || params.get('taspk');

      if (!trackId || !comPk || !tasPk) {
        return null;
      }

      return {
        trackId,
        comPk: parseInt(comPk, 10),
        tasPk: parseInt(tasPk, 10),
      };
    } catch {
      return null;
    }
  }

  /**
   * Load task and track from AirScore URL
   */
  async function loadAirScoreFromUrl(url: string): Promise<void> {
    const params = parseAirScoreUrl(url);

    if (!params) {
      showStatus('Invalid AirScore URL. Expected format: https://xc.highcloud.net/tracklog_map.html?trackid=...&comPk=...&tasPk=...', 'error');
      return;
    }

    showStatus('Loading from AirScore...', 'info');

    try {
      // Fetch task data first
      const taskData = await fetchAirScoreTask(params.comPk, params.tasPk);

      // Set the task
      state.task = taskData.task;

      if (mapRenderer) {
        mapRenderer.setTask(taskData.task);
      }

      analysisPanel?.setTask(taskData.task);

      // Now fetch the track
      const igcContent = await fetchAirScoreTrack(params.trackId, params.comPk, params.tasPk);

      // Parse and load the IGC content
      const igcFile = parseIGC(igcContent);

      state.igcFile = igcFile;
      state.fixes = igcFile.fixes;

      // Update map with track
      if (mapRenderer) {
        mapRenderer.setTrack(igcFile.fixes);
      }

      // Detect events with the loaded task
      state.events = detectFlightEvents(igcFile.fixes, state.task);

      // Update analysis panel
      analysisPanel?.setEvents(state.events);
      analysisPanel?.setAltitudes(igcFile.fixes.map(f => f.gnssAltitude), igcFile.fixes.map(f => f.time));

      // Update map events
      if (mapRenderer) {
        mapRenderer.setEvents(state.events);
      }

      // Update flight info and score
      updateFlightInfo();
      updateScore();

      // Build a descriptive filename
      const pilotName = taskData.pilots.find(p => p.trackId === params.trackId)?.name || 'Unknown';
      const taskName = taskData.competition.taskName || `Task ${params.tasPk}`;

      showStatus(`Loaded ${pilotName} - ${taskData.competition.name} ${taskName}`, 'success');
    } catch (err) {
      console.error('Failed to load from AirScore:', err);
      showStatus(`Failed to load from AirScore: ${err}`, 'error');
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

    analysisPanel?.setFlightInfo(info);
  }

  /**
   * Update score when task and track are both available
   */
  function updateScore(): void {
    if (state.task && state.fixes.length > 0) {
      analysisPanel?.setScore(resolveTurnpointSequence(state.task, state.fixes));
    } else {
      analysisPanel?.setScore(null);
    }
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

  // Map sample track filenames to local task files (by competition date)
  const sampleTaskMap: Record<string, string> = {
    '2026-01-05-RohanHolt-XFH-000-01.IGC': 'buje',
    '2026-01-05-shane-dunc-XCT-SDU-02.igc': 'doza',
    '20260105-132715-GordonRigg.999.igc': 'buje',
    'burkitt_18393_050126.igc': 'buje',
    'durand_45515_050126.igc': 'buje',
    'holtkamp_33915_050126.igc': 'buje',
  };

  async function loadLocalTask(taskFile: string): Promise<void> {
    try {
      const response = await fetch(`/data/tasks/${taskFile}.xctask`);
      if (!response.ok) {
        throw new Error(`Failed to fetch task: ${response.status}`);
      }
      const rawJson = await response.text();
      const task = parseXCTask(rawJson);

      state.task = task;

      if (mapRenderer) {
        mapRenderer.setTask(task);
      }

      analysisPanel?.setTask(task);

      if (state.fixes.length > 0) {
        state.events = detectFlightEvents(state.fixes, task);
        analysisPanel?.setEvents(state.events);
        if (mapRenderer) {
          mapRenderer.setEvents(state.events);
        }
      }

      updateFlightInfo();
      updateScore();
    } catch (err) {
      console.warn('Failed to load local task:', err);
      throw err;
    }
  }

  const loadSampleFile = (filename: string) => {
    const params = new URLSearchParams(window.location.search);
    const taskFile = sampleTaskMap[filename];
    if (taskFile) {
      params.set('task', taskFile);
    } else {
      params.delete('task');
    }
    params.set('track', filename);
    window.location.search = params.toString();
  };

  Object.entries(sampleFiles).forEach(([id, filename]) => {
    document.getElementById(id)?.addEventListener('click', () => loadSampleFile(filename));
  });

  // Load from query params if present (e.g., ?task=buje&track=sample.igc)
  await loadFromQueryParams(loadTask, loadLocalTask, loadIGCFile);
}

/**
 * Parse URL query parameters and load task/track if specified
 */
async function loadFromQueryParams(
  loadTask: (code: string) => Promise<void>,
  loadLocalTask: (taskFile: string) => Promise<void>,
  loadIGCFile: (file: File) => Promise<void>
): Promise<void> {
  const params = new URLSearchParams(window.location.search);

  const taskCode = params.get('task');
  const trackFile = params.get('track');

  // Load task first if specified - try local file first, then remote
  if (taskCode) {
    try {
      await loadLocalTask(taskCode);
    } catch {
      await loadTask(taskCode);
    }
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
