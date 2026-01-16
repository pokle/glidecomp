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
import { fetchTaskByCode, parseXCTask, XCTask, calculateOptimizedTaskDistance } from './xctsk-parser';
import { createMapProvider, getProviderFromUrl, getProviderCode, MapProvider } from './map-provider';
import { detectFlightEvents, FlightEvent } from './event-detector';
import { createEventPanel, EventPanel, FlightInfo } from './event-panel';

// CSS for maplibre-gl and mapbox-gl
import 'maplibre-gl/dist/maplibre-gl.css';
import 'mapbox-gl/dist/mapbox-gl.css';
// App styles (Tailwind + DaisyUI + custom overrides)
import '../app.css';
// Analysis-specific custom styles
import './analysis.css';

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

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  const mapContainer = document.getElementById('map');
  const eventPanelContainer = document.getElementById('event-panel-container');
  const igcFileInput = document.getElementById('igc-file') as HTMLInputElement;
  const taskCodeInput = document.getElementById('task-code') as HTMLInputElement;
  const loadTaskBtn = document.getElementById('load-task-btn');
  const statusEl = document.getElementById('status');
  const dropZone = document.getElementById('drop-zone');
  const mapProviderSelect = document.getElementById('map-provider') as HTMLSelectElement | null;
  const panelToggleBtn = document.getElementById('panel-toggle');

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Get provider from URL (?m=l for leaflet, ?m=g for google, ?m=m for maplibre)
  const providerType = getProviderFromUrl();
  console.log(`[Analysis] Using map provider: ${providerType}`);

  // Set the select to match current provider and handle changes
  if (mapProviderSelect) {
    mapProviderSelect.value = getProviderCode(providerType);
    mapProviderSelect.addEventListener('change', () => {
      const params = new URLSearchParams(window.location.search);
      params.set('m', mapProviderSelect.value);
      window.location.search = params.toString();
    });
  }

  // Initialize map with selected provider
  try {
    mapRenderer = await createMapProvider(providerType, mapContainer);

    // Update event panel when map moves (but not during programmatic pans from event clicks)
    mapRenderer.onBoundsChange(() => {
      if (eventPanel && !isProgrammaticPan) {
        eventPanel.filterByBounds(mapRenderer!.getBounds());
      }
    });
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Set up altitude colors toggle (only shown for providers that support it)
  const altitudeColorsContainer = document.getElementById('altitude-colors-container');
  const altitudeColorsToggle = document.getElementById('altitude-colors-toggle') as HTMLInputElement | null;

  if (mapRenderer.supportsAltitudeColors && altitudeColorsContainer && altitudeColorsToggle) {
    // Show the altitude colors toggle
    altitudeColorsContainer.style.display = 'block';

    // Check URL for initial altitude colors state
    const params = new URLSearchParams(window.location.search);
    const isAltitudeColorsEnabled = params.get('alt') === '1';
    altitudeColorsToggle.checked = isAltitudeColorsEnabled;

    // Apply initial altitude colors state
    if (isAltitudeColorsEnabled && mapRenderer.setAltitudeColors) {
      mapRenderer.setAltitudeColors(true);
    }

    // Handle altitude colors toggle changes
    altitudeColorsToggle.addEventListener('change', () => {
      if (mapRenderer?.setAltitudeColors) {
        mapRenderer.setAltitudeColors(altitudeColorsToggle.checked);

        // Update URL to persist the altitude colors state
        const params = new URLSearchParams(window.location.search);
        if (altitudeColorsToggle.checked) {
          params.set('alt', '1');
        } else {
          params.delete('alt');
        }
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', newUrl);
      }
    });
  }

  // Set up 3D toggle (only shown for providers that support it)
  const threeDToggleContainer = document.getElementById('3d-toggle-container');
  const threeDToggle = document.getElementById('3d-toggle') as HTMLInputElement | null;

  if (mapRenderer.supports3D && threeDToggleContainer && threeDToggle) {
    // Show the 3D toggle
    threeDToggleContainer.style.display = 'block';

    // Check URL for initial 3D state
    const params = new URLSearchParams(window.location.search);
    const is3DEnabled = params.get('3d') === '1';
    threeDToggle.checked = is3DEnabled;

    // Apply initial 3D state
    if (is3DEnabled && mapRenderer.set3DMode) {
      mapRenderer.set3DMode(true);
    }

    // Handle 3D toggle changes
    threeDToggle.addEventListener('change', () => {
      if (mapRenderer?.set3DMode) {
        mapRenderer.set3DMode(threeDToggle.checked);

        // Update URL to persist the 3D state
        const params = new URLSearchParams(window.location.search);
        if (threeDToggle.checked) {
          params.set('3d', '1');
        } else {
          params.delete('3d');
        }
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', newUrl);
      }
    });
  }

  // Initialize event panel
  eventPanel = createEventPanel({
    container: eventPanelContainer,
    onEventClick: (event) => {
      if (mapRenderer) {
        // Suppress bounds-based filtering during programmatic pan
        isProgrammaticPan = true;
        mapRenderer.panToEvent(event);
        // Re-enable filtering after animation completes (~1 second)
        setTimeout(() => {
          isProgrammaticPan = false;
        }, 1200);
      }
    },
    onToggle: () => {
      // Resize map when panel is collapsed/expanded
      if (mapRenderer) {
        mapRenderer.invalidateSize();
      }
    },
  });

  // Panel toggle button (hamburger menu in header)
  panelToggleBtn?.addEventListener('click', () => {
    if (eventPanel) {
      eventPanel.toggle();
    }
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
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');

      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.igc')) {
        await loadIGCFile(file);
      } else {
        showStatus('Please drop an IGC file', 'error');
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

  taskCodeInput?.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      const code = taskCodeInput.value.trim();
      if (code) {
        await loadTask(code);
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
      if (eventPanel) {
        eventPanel.setEvents(state.events);
      }

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

        if (eventPanel) {
          eventPanel.setEvents(state.events);
        }

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
    if (!eventPanel) return;

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

        // Calculate max altitude
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

    eventPanel.setFlightInfo(info);
  }

  /**
   * Show status message
   */
  function showStatus(message: string, type: 'info' | 'success' | 'error'): void {
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = `status status-${type}`;

    // Auto-hide success messages
    if (type === 'success') {
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'status';
      }, 3000);
    }
  }

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
    // Only allow alphanumeric, dash, underscore, dot, and must end with .igc
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
