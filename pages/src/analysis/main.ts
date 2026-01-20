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
import { fetchTaskByCode, XCTask, calculateOptimizedTaskDistance } from './xctsk-parser';
import { createMapProvider, MapProvider } from './map-provider';
import { detectFlightEvents, FlightEvent } from './event-detector';
import { createEventPanel, EventPanel, FlightInfo } from './event-panel';

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
let isProgrammaticPan = false;

// Feature states
let isAltitudeColorsEnabled = false;
let is3DTrackEnabled = false;

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  const mapContainer = document.getElementById('map');
  const eventPanelContainer = document.getElementById('event-panel-container');
  const igcFileInput = document.getElementById('igc-file') as HTMLInputElement;
  const fileBtn = document.getElementById('file-btn');
  const taskCodeInput = document.getElementById('task-code') as HTMLInputElement | null;
  const loadTaskBtn = document.getElementById('load-task-btn');
  const dropZone = document.getElementById('drop-zone');
  const commandDialog = document.getElementById('command-dialog') as HTMLDialogElement | null;

  // Feature menu items
  const menuAltitudeColors = document.getElementById('menu-altitude-colors');
  const menu3DTrack = document.getElementById('menu-3d-track');
  const altitudeColorsStatus = document.getElementById('altitude-colors-status');
  const threeDTrackStatus = document.getElementById('3d-track-status');

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

    // Update event panel when map moves (but not during programmatic pans from event clicks)
    mapRenderer.onBoundsChange(() => {
      if (!isProgrammaticPan) {
        eventPanel?.filterByBounds(mapRenderer!.getBounds());
      }
    });
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Load feature states from URL params
  const params = new URLSearchParams(window.location.search);

  // Set up altitude colors toggle
  if (mapRenderer.supportsAltitudeColors && menuAltitudeColors) {
    isAltitudeColorsEnabled = params.get('alt') === '1';
    updateFeatureStatus(altitudeColorsStatus, isAltitudeColorsEnabled);

    if (isAltitudeColorsEnabled && mapRenderer.setAltitudeColors) {
      mapRenderer.setAltitudeColors(true);
    }

    menuAltitudeColors.addEventListener('click', () => {
      isAltitudeColorsEnabled = !isAltitudeColorsEnabled;
      updateFeatureStatus(altitudeColorsStatus, isAltitudeColorsEnabled);

      if (mapRenderer?.setAltitudeColors) {
        mapRenderer.setAltitudeColors(isAltitudeColorsEnabled);
        updateUrlParam('alt', isAltitudeColorsEnabled ? '1' : null);
      }

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

      // Close the command dialog
      commandDialog?.close();
    });
  } else if (menu3DTrack) {
    menu3DTrack.style.display = 'none';
  }

  // Set up sidebar toggle for mobile
  if (sidebar && sidebarBackdrop) {
    // Listen for Basecoat sidebar events
    document.addEventListener('basecoat:sidebar', ((e: CustomEvent) => {
      const detail = e.detail || {};

      if (detail.id && detail.id !== 'waypoint-sidebar') return;

      const isOpen = sidebar.getAttribute('aria-hidden') === 'false';

      if (detail.action === 'close' || (detail.action === undefined && isOpen)) {
        sidebar.setAttribute('aria-hidden', 'true');
        sidebar.classList.add('-translate-x-full');
        sidebarBackdrop.classList.add('hidden');
      } else {
        sidebar.setAttribute('aria-hidden', 'false');
        sidebar.classList.remove('-translate-x-full');
        sidebarBackdrop.classList.remove('hidden');
      }
    }) as EventListener);
  }

  // Handle event click
  const handleEventClick = (event: FlightEvent) => {
    if (mapRenderer) {
      isProgrammaticPan = true;
      mapRenderer.panToEvent(event);
      setTimeout(() => {
        isProgrammaticPan = false;
      }, 1200);
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

  // File button triggers hidden file input
  fileBtn?.addEventListener('click', () => {
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

  // Task code handler
  loadTaskBtn?.addEventListener('click', async () => {
    const code = taskCodeInput?.value.trim();
    if (code) {
      await loadTask(code);
    }
  });

  taskCodeInput?.addEventListener('keydown', async (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      const code = taskCodeInput.value.trim();
      if (code) {
        await loadTask(code);
      }
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

      showStatus(`Loaded ${file.name} - ${igcFile.fixes.length} fixes`, 'success');
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
        info.maxAlt = `${maxAlt}m`;
      }
    }

    if (state.task) {
      const numTurnpoints = state.task.turnpoints.length;
      const optimizedDistance = calculateOptimizedTaskDistance(state.task);
      const distanceKm = (optimizedDistance / 1000).toFixed(2);
      info.task = `${numTurnpoints} TPs, ${distanceKm} km`;
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
  };

  const loadSampleFile = async (filename: string) => {
    try {
      const response = await fetch(`/samples/${filename}`);
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
      const response = await fetch(`/samples/${trackFile}`);
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
