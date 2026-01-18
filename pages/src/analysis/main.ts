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
import { createMapProvider, getProviderFromUrl, getProviderCode, MapProvider, MapProviderType } from './map-provider';
import { detectFlightEvents, FlightEvent } from './event-detector';
import { createEventPanel, EventPanel, FlightInfo } from './event-panel';

// CSS for maplibre-gl and mapbox-gl (Shoelace CSS is loaded in the HTML)
import 'maplibre-gl/dist/maplibre-gl.css';
import 'mapbox-gl/dist/mapbox-gl.css';
// Note: Shoelace theme and app styles are in analysis.html

// Shoelace types
interface SlInput extends HTMLElement {
  value: string;
}

interface SlMenuItem extends HTMLElement {
  checked: boolean;
  value: string;
}

interface SlButton extends HTMLElement {
  variant: string;
}

interface SlAlert extends HTMLElement {
  variant: string;
  open: boolean;
  duration: number;
  toast(): void;
}

interface SlDrawer extends HTMLElement {
  show(): void;
  hide(): void;
}

interface AppState {
  igcFile: IGCFile | null;
  task: XCTask | null;
  fixes: IGCFix[];
  events: FlightEvent[];
  viewMode: 'list' | 'both' | 'map';
}

const state: AppState = {
  igcFile: null,
  task: null,
  fixes: [],
  events: [],
  viewMode: 'both',
};

let mapRenderer: MapProvider | null = null;
let eventPanel: EventPanel | null = null;
let drawerEventPanel: EventPanel | null = null;
let isProgrammaticPan = false;

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  const mapContainer = document.getElementById('map');
  const eventPanelContainer = document.getElementById('event-panel-container');
  const eventDrawerContainer = document.getElementById('event-drawer-container');
  const eventDrawer = document.getElementById('event-drawer') as SlDrawer | null;
  const igcFileInput = document.getElementById('igc-file') as HTMLInputElement;
  const fileBtn = document.getElementById('file-btn');
  const taskCodeInput = document.getElementById('task-code') as SlInput | null;
  const loadTaskBtn = document.getElementById('load-task-btn');
  // Mobile controls
  const igcFileInputMobile = document.getElementById('igc-file-mobile') as HTMLInputElement | null;
  const fileBtnMobile = document.getElementById('file-btn-mobile');
  const taskCodeInputMobile = document.getElementById('task-code-mobile') as SlInput | null;
  const loadTaskBtnMobile = document.getElementById('load-task-btn-mobile');
  const dropZone = document.getElementById('drop-zone');
  const mainContainer = document.getElementById('main-container');
  const eventDrawerDesktop = document.getElementById('event-drawer-desktop') as SlDrawer | null;

  // View mode buttons
  const viewListBtn = document.getElementById('view-list') as SlButton | null;
  const viewBothBtn = document.getElementById('view-both') as SlButton | null;
  const viewMapBtn = document.getElementById('view-map') as SlButton | null;

  // Settings menu items
  const providerLeaflet = document.getElementById('provider-leaflet') as SlMenuItem | null;
  const providerGoogle = document.getElementById('provider-google') as SlMenuItem | null;
  const providerMaplibre = document.getElementById('provider-maplibre') as SlMenuItem | null;
  const providerMapbox = document.getElementById('provider-mapbox') as SlMenuItem | null;
  const menuAltitudeColors = document.getElementById('menu-altitude-colors') as SlMenuItem | null;
  const menu3DTrack = document.getElementById('menu-3d-track') as SlMenuItem | null;
  const menuThemeDark = document.getElementById('menu-theme-dark') as SlMenuItem | null;
  const menuThemeLight = document.getElementById('menu-theme-light') as SlMenuItem | null;

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Get provider from URL (?m=l for leaflet, ?m=g for google, ?m=m for maplibre)
  const providerType = getProviderFromUrl();
  console.log(`[Analysis] Using map provider: ${providerType}`);

  // Set the correct provider menu item as checked
  const providerMap: Record<MapProviderType, SlMenuItem | null> = {
    leaflet: providerLeaflet,
    google: providerGoogle,
    maplibre: providerMaplibre,
    mapbox: providerMapbox,
  };

  Object.entries(providerMap).forEach(([type, item]) => {
    if (item) {
      item.checked = type === providerType;
    }
  });

  // Handle provider menu selection
  const handleProviderSelect = (selectedProvider: MapProviderType) => {
    const params = new URLSearchParams(window.location.search);
    params.set('m', getProviderCode(selectedProvider));
    window.location.search = params.toString();
  };

  providerLeaflet?.addEventListener('click', () => handleProviderSelect('leaflet'));
  providerGoogle?.addEventListener('click', () => handleProviderSelect('google'));
  providerMaplibre?.addEventListener('click', () => handleProviderSelect('maplibre'));
  providerMapbox?.addEventListener('click', () => handleProviderSelect('mapbox'));

  // Initialize map with selected provider
  try {
    mapRenderer = await createMapProvider(providerType, mapContainer);

    // Update event panel when map moves (but not during programmatic pans from event clicks)
    mapRenderer.onBoundsChange(() => {
      if (!isProgrammaticPan) {
        eventPanel?.filterByBounds(mapRenderer!.getBounds());
        drawerEventPanel?.filterByBounds(mapRenderer!.getBounds());
      }
    });
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'danger');
    return;
  }

  // Set up altitude colors toggle
  const params = new URLSearchParams(window.location.search);

  if (mapRenderer.supportsAltitudeColors && menuAltitudeColors) {
    const isAltitudeColorsEnabled = params.get('alt') === '1';
    menuAltitudeColors.checked = isAltitudeColorsEnabled;

    if (isAltitudeColorsEnabled && mapRenderer.setAltitudeColors) {
      mapRenderer.setAltitudeColors(true);
    }

    menuAltitudeColors.addEventListener('click', () => {
      const newState = !menuAltitudeColors.checked;
      menuAltitudeColors.checked = newState;

      if (mapRenderer?.setAltitudeColors) {
        mapRenderer.setAltitudeColors(newState);
        const params = new URLSearchParams(window.location.search);
        if (newState) {
          params.set('alt', '1');
        } else {
          params.delete('alt');
        }
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', newUrl);
      }
    });
  } else if (menuAltitudeColors) {
    menuAltitudeColors.style.display = 'none';
  }

  // Set up 3D toggle
  if (mapRenderer.supports3D && menu3DTrack) {
    const is3DEnabled = params.get('3d') === '1';
    menu3DTrack.checked = is3DEnabled;

    if (is3DEnabled && mapRenderer.set3DMode) {
      mapRenderer.set3DMode(true);
    }

    menu3DTrack.addEventListener('click', () => {
      const newState = !menu3DTrack.checked;
      menu3DTrack.checked = newState;

      if (mapRenderer?.set3DMode) {
        mapRenderer.set3DMode(newState);
        const params = new URLSearchParams(window.location.search);
        if (newState) {
          params.set('3d', '1');
        } else {
          params.delete('3d');
        }
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', newUrl);
      }
    });
  } else if (menu3DTrack) {
    menu3DTrack.style.display = 'none';
  }

  // Set up theme toggle
  const setTheme = (theme: 'dark' | 'light') => {
    const html = document.documentElement;
    if (theme === 'dark') {
      html.classList.remove('sl-theme-light');
      html.classList.add('sl-theme-dark');
      if (menuThemeDark) menuThemeDark.checked = true;
      if (menuThemeLight) menuThemeLight.checked = false;
    } else {
      html.classList.remove('sl-theme-dark');
      html.classList.add('sl-theme-light');
      if (menuThemeDark) menuThemeDark.checked = false;
      if (menuThemeLight) menuThemeLight.checked = true;
    }
    // Save preference
    localStorage.setItem('theme', theme);
  };

  // Load saved theme preference
  const savedTheme = localStorage.getItem('theme') as 'dark' | 'light' | null;
  if (savedTheme) {
    setTheme(savedTheme);
  }

  menuThemeDark?.addEventListener('click', () => setTheme('dark'));
  menuThemeLight?.addEventListener('click', () => setTheme('light'));

  // Handle event click
  const handleEventClick = (event: FlightEvent) => {
    if (mapRenderer) {
      isProgrammaticPan = true;
      mapRenderer.panToEvent(event);
      setTimeout(() => {
        isProgrammaticPan = false;
      }, 1200);
    }
  };

  // Handle panel toggle
  const handlePanelToggle = () => {
    if (mapRenderer) {
      mapRenderer.invalidateSize();
    }
  };

  // Initialize desktop event panel
  eventPanel = createEventPanel({
    container: eventPanelContainer,
    onEventClick: handleEventClick,
    onToggle: handlePanelToggle,
  });

  // Initialize drawer event panel for mobile
  if (eventDrawerContainer) {
    drawerEventPanel = createEventPanel({
      container: eventDrawerContainer,
      onEventClick: (event) => {
        handleEventClick(event);
        eventDrawer?.hide();
      },
      onToggle: handlePanelToggle,
    });
  }

  // View mode toggle
  const setViewMode = (mode: 'list' | 'both' | 'map') => {
    state.viewMode = mode;

    // Update button variants
    if (viewListBtn) viewListBtn.variant = mode === 'list' ? 'primary' : 'default';
    if (viewBothBtn) viewBothBtn.variant = mode === 'both' ? 'primary' : 'default';
    if (viewMapBtn) viewMapBtn.variant = mode === 'map' ? 'primary' : 'default';

    // Update layout
    if (mainContainer) {
      mainContainer.classList.remove('view-list', 'view-both', 'view-map');
      mainContainer.classList.add(`view-${mode}`);
    }

    // Handle drawer visibility based on mode
    if (window.innerWidth <= 768) {
      // Mobile: use bottom drawer
      if (mode === 'list') {
        eventDrawer?.show();
      } else {
        eventDrawer?.hide();
      }
    } else {
      // Desktop: use side drawer
      if (mode === 'map') {
        eventDrawerDesktop?.hide();
      } else {
        eventDrawerDesktop?.show();
      }
    }

    // Resize map after layout change
    setTimeout(() => {
      mapRenderer?.invalidateSize();
    }, 350);
  };

  viewListBtn?.addEventListener('click', () => setViewMode('list'));
  viewBothBtn?.addEventListener('click', () => setViewMode('both'));
  viewMapBtn?.addEventListener('click', () => setViewMode('map'));

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

  // Mobile controls handlers
  fileBtnMobile?.addEventListener('click', () => {
    igcFileInputMobile?.click();
  });

  igcFileInputMobile?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      await loadIGCFile(file);
    }
  });

  loadTaskBtnMobile?.addEventListener('click', async () => {
    const code = taskCodeInputMobile?.value.trim();
    if (code) {
      await loadTask(code);
    }
  });

  taskCodeInputMobile?.addEventListener('keydown', async (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      const code = taskCodeInputMobile.value.trim();
      if (code) {
        await loadTask(code);
      }
    }
  });

  /**
   * Load and parse an IGC file
   */
  async function loadIGCFile(file: File): Promise<void> {
    showStatus('Loading IGC file...', 'primary');

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

      // Update event panels
      eventPanel?.setEvents(state.events);
      drawerEventPanel?.setEvents(state.events);

      // Update map events
      if (mapRenderer) {
        mapRenderer.setEvents(state.events);
      }

      // Update flight info
      updateFlightInfo();

      showStatus(`Loaded ${file.name} - ${igcFile.fixes.length} fixes`, 'success');
    } catch (err) {
      console.error('Failed to parse IGC file:', err);
      showStatus(`Failed to parse IGC file: ${err}`, 'danger');
    }
  }

  /**
   * Load task by code
   */
  async function loadTask(code: string): Promise<void> {
    showStatus(`Loading task ${code}...`, 'primary');

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
        drawerEventPanel?.setEvents(state.events);

        if (mapRenderer) {
          mapRenderer.setEvents(state.events);
        }
      }

      // Update flight info
      updateFlightInfo();

      showStatus(`Loaded task: ${task.turnpoints.length} turnpoints`, 'success');
    } catch (err) {
      console.error('Failed to load task:', err);
      showStatus(`Failed to load task: ${err}`, 'danger');
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
    drawerEventPanel?.setFlightInfo(info);
  }

  /**
   * Show status message using Shoelace alert
   */
  function showStatus(message: string, variant: 'primary' | 'success' | 'warning' | 'danger'): void {
    const statusEl = document.getElementById('status') as SlAlert | null;
    if (!statusEl) return;

    // Update the alert content
    const iconName = {
      primary: 'info-circle',
      success: 'check2-circle',
      warning: 'exclamation-triangle',
      danger: 'exclamation-octagon',
    }[variant];

    statusEl.innerHTML = `
      <sl-icon slot="icon" name="${iconName}"></sl-icon>
      ${message}
    `;
    statusEl.variant = variant;
    statusEl.open = true;

    // Auto-hide for success messages
    if (variant === 'success') {
      statusEl.duration = 3000;
    } else {
      statusEl.duration = Infinity;
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
    } catch (err) {
      console.error('Failed to load sample file:', err);
      showStatus(`Failed to load sample: ${err}`, 'danger');
    }
  };

  Object.entries(sampleFiles).forEach(([id, filename]) => {
    document.getElementById(id)?.addEventListener('click', () => loadSampleFile(filename));
  });

  showStatus('Ready - drop an IGC file or use the file picker', 'primary');

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
