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
import { fetchTaskByCode, parseXCTask, XCTask } from './xctsk-parser';
import { createMap, MapRenderer } from './map-renderer';
import { detectFlightEvents, FlightEvent } from './event-detector';
import { createEventPanel, EventPanel } from './event-panel';

// CSS for maplibre-gl
import 'maplibre-gl/dist/maplibre-gl.css';

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

let mapRenderer: MapRenderer | null = null;
let eventPanel: EventPanel | null = null;

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
  const flightInfoEl = document.getElementById('flight-info');
  const dropZone = document.getElementById('drop-zone');

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Initialize map
  try {
    mapRenderer = await createMap(mapContainer);

    // Update event panel when map moves
    mapRenderer.onBoundsChange(() => {
      if (eventPanel) {
        eventPanel.filterByBounds(mapRenderer!.getBounds());
      }
    });
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Initialize event panel
  eventPanel = createEventPanel({
    container: eventPanelContainer,
    onEventClick: (event) => {
      if (mapRenderer) {
        mapRenderer.panToEvent(event);
      }
    },
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
    if (!flightInfoEl) return;

    const parts: string[] = [];

    if (state.igcFile) {
      const h = state.igcFile.header;

      if (h.date) {
        parts.push(`<strong>Date:</strong> ${h.date.toLocaleDateString()}`);
      }

      if (h.pilot) {
        parts.push(`<strong>Pilot:</strong> ${h.pilot}`);
      }

      if (h.gliderType) {
        parts.push(`<strong>Glider:</strong> ${h.gliderType}`);
      }

      if (state.fixes.length > 0) {
        const duration = state.fixes[state.fixes.length - 1].time.getTime() -
                        state.fixes[0].time.getTime();
        const hours = Math.floor(duration / 3600000);
        const mins = Math.floor((duration % 3600000) / 60000);
        parts.push(`<strong>Duration:</strong> ${hours}h ${mins}m`);

        // Calculate max altitude
        const maxAlt = Math.max(...state.fixes.map(f => f.gnssAltitude));
        parts.push(`<strong>Max Alt:</strong> ${maxAlt}m`);
      }
    }

    if (state.task) {
      parts.push(`<strong>Task:</strong> ${state.task.turnpoints.length} TPs`);
    }

    flightInfoEl.innerHTML = parts.length > 0
      ? parts.join(' | ')
      : 'Load an IGC file to see flight info';
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
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
