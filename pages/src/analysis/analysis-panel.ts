/**
 * Analysis Panel Component
 *
 * Main tabbed panel with Track, Task, and Terrain tabs.
 * Provides a unified interface for flight analysis data.
 */

import { FlightEvent, FlightEventType, getEventStyle } from './event-detector';
import { formatAltitude, formatSpeed, formatDistance, formatClimbRate } from './units';
import { XCTask, getOptimizedSegmentDistances } from './xctsk-parser';

/**
 * View modes for the Track sub-tabs
 */
type TrackViewMode = 'all' | 'glides' | 'climbs' | 'sinks';

/**
 * Main panel tabs
 */
export type PanelTabType = 'track' | 'task' | 'terrain';
type PanelTab = PanelTabType;

/**
 * Combined glide data from start and end events
 */
interface GlideData {
  id: string;
  startTime: Date;
  endTime: Date;
  startAltitude: number;
  endAltitude: number;
  distance: number;
  duration: number;
  averageSpeed: number;
  glideRatio: number;
  altitudeLost: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  segment: { startIndex: number; endIndex: number };
  sourceEvent: FlightEvent;
}

/**
 * Combined climb/thermal data from entry and exit events
 */
interface ClimbData {
  id: string;
  startTime: Date;
  endTime: Date;
  startAltitude: number;
  endAltitude: number;
  altitudeGain: number;
  duration: number;
  avgClimbRate: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  segment: { startIndex: number; endIndex: number };
  sourceEvent: FlightEvent;
}

/**
 * Combined sink/descent data
 */
interface SinkData {
  id: string;
  startTime: Date;
  endTime: Date;
  startAltitude: number;
  endAltitude: number;
  altitudeLost: number;
  distance: number;
  duration: number;
  averageSpeed: number;
  avgSinkRate: number;
  glideRatio: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  segment: { startIndex: number; endIndex: number };
  sourceEvent: FlightEvent;
}

export interface AnalysisPanelOptions {
  container: HTMLElement;
  onEventClick: (event: FlightEvent, options?: { skipPan?: boolean }) => void;
  onToggle?: () => void;
  onHide?: () => void;
  onShow?: () => void;
}

export interface FlightInfo {
  date?: string;
  pilot?: string;
  glider?: string;
  duration?: string;
  maxAlt?: string;
  task?: string;
}

export interface AnalysisPanel {
  setEvents(events: FlightEvent[]): void;
  setFlightInfo(info: FlightInfo): void;
  setTask(task: XCTask | null): void;
  clearSelection(): void;
  toggle(): void;
  open(): void;
  hide(): void;
  show(): void;
  isHidden(): boolean;
  switchTab(tab: PanelTabType): void;
  getCurrentTab(): PanelTabType;
  selectByFixIndex(fixIndex: number, options?: { skipPan?: boolean }): void;
  destroy(): void;
}

// Terrain jokes about emptiness
const TERRAIN_JOKES = [
  "This space is emptier than a thermal at sunset.",
  "Nothing here yet... like a glider without wind.",
  "Terrain data coming soon. For now, enjoy the view of nothing.",
  "It's so empty here, even the vultures left.",
  "This panel is flatter than Kansas on a no-fly day.",
  "No terrain data. Just like my landing options after a bomb-out.",
  "Coming soon: actual terrain info. For now, pretend you can see thermals.",
  "This area is as empty as cloudbase on a blue day.",
  "Terrain info? We're working on it. Unlike that thermal you're chasing.",
  "Nothing to see here. Much like your vario in sink.",
];

/**
 * Format time as HH:MM:SS
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Get human-readable event type label
 */
function getEventTypeLabel(type: FlightEventType): string {
  const labels: Record<FlightEventType, string> = {
    takeoff: 'Takeoff',
    landing: 'Landing',
    thermal_entry: 'Thermal Entry',
    thermal_exit: 'Thermal Exit',
    glide_start: 'Glide Start',
    glide_end: 'Glide End',
    turnpoint_entry: 'TP Entry',
    turnpoint_exit: 'TP Exit',
    start_crossing: 'Start',
    goal_crossing: 'Goal',
    max_altitude: 'Max Alt',
    min_altitude: 'Min Alt',
    max_climb: 'Max Climb',
    max_sink: 'Max Sink',
  };
  return labels[type] || type;
}

/**
 * Get icon SVG for event type
 */
function getEventIcon(type: FlightEventType): string {
  const icons: Partial<Record<FlightEventType, string>> = {
    takeoff: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 19h19v2h-19v-2zm19.57-9.36c-.21-.8-1.04-1.28-1.84-1.06L14.92 10l-6.9-6.43-1.93.51 4.14 7.17-4.97 1.33-1.97-1.54-1.45.39 1.82 3.16.77 1.33 1.6-.43 5.31-1.42 4.35-1.16L21 11.49c.81-.23 1.28-1.05 1.07-1.85z"/></svg>`,
    landing: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 19h19v2h-19v-2zm17.16-5.84l-7.29 1.95-6.41-6.14-1.93.52 4.14 7.17-4.97 1.33-1.97-1.54-1.45.39 1.82 3.16.77 1.33 1.6-.43L9.4 19.4l7.29-1.95 3.49-.93c.81-.22 1.28-1.04 1.07-1.84-.22-.81-1.04-1.28-1.84-1.06l-.75.2z"/></svg>`,
    thermal_entry: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>`,
    thermal_exit: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/></svg>`,
    glide_start: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/></svg>`,
    glide_end: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l1.41 1.41L7.83 11H20v2H7.83l5.58 5.59L12 20l-8-8 8-8z"/></svg>`,
    turnpoint_entry: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`,
    turnpoint_exit: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`,
    start_crossing: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>`,
    goal_crossing: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/></svg>`,
    max_altitude: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/></svg>`,
    min_altitude: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/></svg>`,
    max_climb: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>`,
    max_sink: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 18l2.29-2.29-4.88-4.88-4 4L2 7.41 3.41 6l6 6 4-4 6.3 6.29L22 12v6z"/></svg>`,
  };
  return icons[type] || `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`;
}

/**
 * Format duration in mm:ss
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get turnpoint type label
 */
function getTurnpointTypeLabel(type?: 'TAKEOFF' | 'SSS' | 'ESS'): string {
  switch (type) {
    case 'TAKEOFF': return 'Takeoff';
    case 'SSS': return 'Start';
    case 'ESS': return 'Goal';
    default: return 'Turnpoint';
  }
}

/**
 * Get turnpoint type CSS class for styling
 */
function getTurnpointTypeClass(type?: 'TAKEOFF' | 'SSS' | 'ESS'): string {
  switch (type) {
    case 'SSS': return 'text-green-600 dark:text-green-400';
    case 'ESS': return 'text-red-600 dark:text-red-400';
    default: return 'text-blue-600 dark:text-blue-400';
  }
}

/**
 * Create the analysis panel
 */
export function createAnalysisPanel(options: AnalysisPanelOptions): AnalysisPanel {
  const { container, onEventClick } = options;

  // Create panel structure (tabs are now in the header, not here)
  const panel = document.createElement('div');
  panel.className = 'flex h-full flex-col overflow-hidden';
  panel.innerHTML = `
    <!-- Track Panel Content -->
    <div id="track-panel-content" class="flex flex-1 flex-col overflow-hidden">
      <div class="border-b border-border bg-muted/50 px-4 py-2 text-sm">
        <div class="flight-info-content text-muted-foreground">Load an IGC file to see flight info</div>
      </div>
      <div class="tabs w-full border-b border-border">
        <nav role="tablist" class="w-full">
          <button type="button" role="tab" id="tab-events" aria-selected="true">Events</button>
          <button type="button" role="tab" id="tab-glides" aria-selected="false">Glides</button>
          <button type="button" role="tab" id="tab-climbs" aria-selected="false">Climbs</button>
          <button type="button" role="tab" id="tab-sinks" aria-selected="false">Sinks</button>
        </nav>
      </div>
      <div class="border-b border-border px-4 py-1.5 text-sm text-muted-foreground">
        <span class="event-count">0 events</span>
      </div>
      <div class="track-list flex-1 overflow-y-auto p-2 scrollbar">
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          Load an IGC file to see events
        </div>
      </div>
    </div>

    <!-- Task Panel Content -->
    <div id="task-panel-content" class="hidden flex flex-1 flex-col overflow-hidden">
      <div class="border-b border-border px-4 py-3">
        <h2 class="text-base font-semibold">Task Turnpoints</h2>
      </div>
      <div class="task-list flex-1 overflow-y-auto p-2 scrollbar">
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          No task loaded
        </div>
      </div>
    </div>

    <!-- Terrain Panel Content -->
    <div id="terrain-panel-content" class="hidden flex flex-1 flex-col overflow-hidden">
      <div class="border-b border-border px-4 py-3">
        <h2 class="text-base font-semibold">Terrain</h2>
      </div>
      <div class="terrain-content flex-1 overflow-y-auto p-4">
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          <div class="space-y-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mx-auto opacity-50">
              <path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/>
            </svg>
            <p class="terrain-joke italic"></p>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(panel);

  // Get references
  const trackPanelContent = panel.querySelector('#track-panel-content') as HTMLElement;
  const taskPanelContent = panel.querySelector('#task-panel-content') as HTMLElement;
  const terrainPanelContent = panel.querySelector('#terrain-panel-content') as HTMLElement;

  const listContainer = panel.querySelector('.track-list') as HTMLElement;
  const eventCountEl = panel.querySelector('.event-count') as HTMLElement;
  const taskListContainer = panel.querySelector('.task-list') as HTMLElement;
  const terrainJokeEl = panel.querySelector('.terrain-joke') as HTMLElement;

  const tabEvents = panel.querySelector('#tab-events') as HTMLButtonElement;
  const tabGlides = panel.querySelector('#tab-glides') as HTMLButtonElement;
  const tabClimbs = panel.querySelector('#tab-climbs') as HTMLButtonElement;
  const tabSinks = panel.querySelector('#tab-sinks') as HTMLButtonElement;
  const trackSubTabs = [tabEvents, tabGlides, tabClimbs, tabSinks];

  const flightInfoEl = panel.querySelector('.flight-info-content') as HTMLElement;

  // State
  let allEvents: FlightEvent[] = [];
  let filteredEvents: FlightEvent[] = [];
  let currentTask: XCTask | null = null;
  let isPanelHidden = false;
  let currentTab: PanelTab = 'track';
  let trackViewMode: TrackViewMode = 'all';
  let selectedSegment: { startIndex: number; endIndex: number } | null = null;

  // Set random terrain joke
  terrainJokeEl.textContent = TERRAIN_JOKES[Math.floor(Math.random() * TERRAIN_JOKES.length)];

  /**
   * Switch main panel tab (called externally from header tabs)
   */
  function switchMainTab(tab: PanelTab): void {
    currentTab = tab;

    // Hide all content panels
    trackPanelContent.classList.add('hidden');
    taskPanelContent.classList.add('hidden');
    terrainPanelContent.classList.add('hidden');

    // Show selected panel
    if (tab === 'track') {
      trackPanelContent.classList.remove('hidden');
    } else if (tab === 'task') {
      taskPanelContent.classList.remove('hidden');
      renderTask();
    } else if (tab === 'terrain') {
      terrainPanelContent.classList.remove('hidden');
      // Pick a new random joke when switching to terrain tab
      terrainJokeEl.textContent = TERRAIN_JOKES[Math.floor(Math.random() * TERRAIN_JOKES.length)];
    }
  }

  /**
   * Switch track sub-tab
   */
  function switchTrackTab(mode: TrackViewMode): void {
    trackViewMode = mode;

    // Update tab states
    for (const tab of trackSubTabs) {
      if (tab) {
        tab.setAttribute('aria-selected', 'false');
      }
    }

    let activeTab: HTMLButtonElement | null = null;
    if (mode === 'all') activeTab = tabEvents;
    else if (mode === 'glides') activeTab = tabGlides;
    else if (mode === 'climbs') activeTab = tabClimbs;
    else if (mode === 'sinks') activeTab = tabSinks;

    if (activeTab) {
      activeTab.setAttribute('aria-selected', 'true');
    }

    renderTrack();

    if (!selectedSegment) {
      listContainer.scrollTop = 0;
    }
  }

  // Track sub-tab click handlers
  tabEvents?.addEventListener('click', () => switchTrackTab('all'));
  tabGlides?.addEventListener('click', () => switchTrackTab('glides'));
  tabClimbs?.addEventListener('click', () => switchTrackTab('climbs'));
  tabSinks?.addEventListener('click', () => switchTrackTab('sinks'));

  /**
   * Hide the panel
   */
  function hidePanel(): void {
    isPanelHidden = true;
    options.onHide?.();
  }

  /**
   * Show the panel
   */
  function showPanel(): void {
    isPanelHidden = false;
    options.onShow?.();
  }

  /**
   * Update filtered events
   */
  function updateFilteredEvents(): void {
    filteredEvents = [...allEvents];
  }

  /**
   * Extract combined glide data
   */
  function extractGlides(): GlideData[] {
    const glides: GlideData[] = [];

    for (const event of allEvents) {
      if (event.type === 'glide_start' && event.segment && event.details) {
        const details = event.details as {
          distance?: number;
          averageSpeed?: number;
          glideRatio?: number;
          duration?: number;
        };

        const endEvent = allEvents.find(
          e => e.type === 'glide_end' &&
               e.segment?.startIndex === event.segment?.startIndex &&
               e.segment?.endIndex === event.segment?.endIndex
        );

        if (endEvent) {
          glides.push({
            id: event.id,
            startTime: event.time,
            endTime: endEvent.time,
            startAltitude: event.altitude,
            endAltitude: endEvent.altitude,
            distance: details.distance || 0,
            duration: details.duration || 0,
            averageSpeed: details.averageSpeed || 0,
            glideRatio: details.glideRatio || 0,
            altitudeLost: event.altitude - endEvent.altitude,
            startLat: event.latitude,
            startLon: event.longitude,
            endLat: endEvent.latitude,
            endLon: endEvent.longitude,
            segment: event.segment,
            sourceEvent: event,
          });
        }
      }
    }

    glides.sort((a, b) => b.distance - a.distance);
    return glides;
  }

  /**
   * Extract combined climb data
   */
  function extractClimbs(): ClimbData[] {
    const climbs: ClimbData[] = [];

    for (const event of allEvents) {
      if (event.type === 'thermal_entry' && event.segment && event.details) {
        const details = event.details as {
          avgClimbRate?: number;
          duration?: number;
          altitudeGain?: number;
        };

        const exitEvent = allEvents.find(
          e => e.type === 'thermal_exit' &&
               e.segment?.startIndex === event.segment?.startIndex &&
               e.segment?.endIndex === event.segment?.endIndex
        );

        if (exitEvent) {
          climbs.push({
            id: event.id,
            startTime: event.time,
            endTime: exitEvent.time,
            startAltitude: event.altitude,
            endAltitude: exitEvent.altitude,
            altitudeGain: details.altitudeGain || (exitEvent.altitude - event.altitude),
            duration: details.duration || 0,
            avgClimbRate: details.avgClimbRate || 0,
            startLat: event.latitude,
            startLon: event.longitude,
            endLat: exitEvent.latitude,
            endLon: exitEvent.longitude,
            segment: event.segment,
            sourceEvent: event,
          });
        }
      }
    }

    climbs.sort((a, b) => b.altitudeGain - a.altitudeGain);
    return climbs;
  }

  /**
   * Extract sink data
   */
  function extractSinks(): SinkData[] {
    const sinks: SinkData[] = [];
    const maxGlideRatioForSink = 5;

    for (const event of allEvents) {
      if (event.type === 'glide_start' && event.segment && event.details) {
        const details = event.details as {
          distance?: number;
          averageSpeed?: number;
          glideRatio?: number;
          duration?: number;
        };

        const glideRatio = details.glideRatio || 0;

        if (glideRatio > maxGlideRatioForSink) {
          continue;
        }

        const endEvent = allEvents.find(
          e => e.type === 'glide_end' &&
               e.segment?.startIndex === event.segment?.startIndex &&
               e.segment?.endIndex === event.segment?.endIndex
        );

        if (endEvent) {
          const altitudeLost = event.altitude - endEvent.altitude;
          const duration = details.duration || 0;
          const avgSinkRate = duration > 0 ? altitudeLost / duration : 0;

          sinks.push({
            id: event.id,
            startTime: event.time,
            endTime: endEvent.time,
            startAltitude: event.altitude,
            endAltitude: endEvent.altitude,
            altitudeLost: altitudeLost,
            distance: details.distance || 0,
            duration: duration,
            averageSpeed: details.averageSpeed || 0,
            avgSinkRate: avgSinkRate,
            glideRatio: glideRatio,
            startLat: event.latitude,
            startLon: event.longitude,
            endLat: endEvent.latitude,
            endLon: endEvent.longitude,
            segment: event.segment,
            sourceEvent: event,
          });
        }
      }
    }

    sinks.sort((a, b) => b.altitudeLost - a.altitudeLost);
    return sinks;
  }

  /**
   * Main render function for track panel
   */
  function renderTrack(): void {
    if (trackViewMode === 'glides') {
      renderGlides();
    } else if (trackViewMode === 'climbs') {
      renderClimbs();
    } else if (trackViewMode === 'sinks') {
      renderSinks();
    } else {
      renderEvents();
    }
  }

  /**
   * Render the event list
   */
  function renderEvents(): void {
    if (filteredEvents.length === 0) {
      listContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          ${allEvents.length === 0 ? 'Load an IGC file to see events' : 'No events in current view'}
        </div>
      `;
      eventCountEl.textContent = `${allEvents.length} events`;
      return;
    }

    eventCountEl.textContent = `${filteredEvents.length} of ${allEvents.length} events`;

    let html = '<div class="space-y-1">';

    for (const event of filteredEvents) {
      const style = getEventStyle(event.type);
      const icon = getEventIcon(event.type);

      html += `
        <button class="event-item" data-event-id="${event.id}">
          <span class="event-icon" style="color: ${style.color}">
            ${icon}
          </span>
          <div class="event-content">
            <span class="event-type">${getEventTypeLabel(event.type)}</span>
            <span class="event-desc">${event.description}</span>
            <span class="event-meta">
              ${formatTime(event.time)} | ${formatAltitude(event.altitude).withUnit}
            </span>
          </div>
        </button>
      `;
    }

    html += '</div>';
    listContainer.innerHTML = html;

    // Add click handlers
    listContainer.querySelectorAll('.event-item').forEach(item => {
      item.addEventListener('click', () => {
        const eventId = item.getAttribute('data-event-id');
        const event = allEvents.find(e => e.id === eventId);
        if (event) {
          onEventClick(event);
          selectedSegment = event.segment || null;
          listContainer.querySelectorAll('.event-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });
    });

    // Restore selection
    if (selectedSegment) {
      const matchingEvent = filteredEvents.find(e =>
        e.segment?.startIndex === selectedSegment!.startIndex &&
        e.segment?.endIndex === selectedSegment!.endIndex
      );
      if (matchingEvent) {
        const item = listContainer.querySelector(`[data-event-id="${matchingEvent.id}"]`);
        if (item) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      }
    }
  }

  /**
   * Render glides list
   */
  function renderGlides(): void {
    const glides = extractGlides();

    if (glides.length === 0) {
      listContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          ${allEvents.length === 0 ? 'Load an IGC file to see glides' : 'No glides detected'}
        </div>
      `;
      eventCountEl.textContent = '0 glides';
      return;
    }

    eventCountEl.textContent = `${glides.length} glides`;

    let html = '<div class="space-y-2">';
    html += '<div class="text-xs text-muted-foreground px-1 pb-2">Sorted by distance (longest first)</div>';

    for (let i = 0; i < glides.length; i++) {
      const glide = glides[i];
      const distanceStr = formatDistance(glide.distance).withUnit;
      const speedStr = formatSpeed(glide.averageSpeed).withUnit;
      const glideRatioStr = glide.glideRatio > 0 ? glide.glideRatio.toFixed(1) : '∞';
      const altLostStr = formatAltitude(glide.altitudeLost).withUnit;
      const startAltStr = formatAltitude(glide.startAltitude).withUnit;
      const endAltStr = formatAltitude(glide.endAltitude).withUnit;

      html += `
        <button class="glide-item" data-glide-id="${glide.id}">
          <div class="glide-rank">#${i + 1}</div>
          <div class="glide-details">
            <div class="glide-primary">
              <span class="glide-distance">${distanceStr}</span>
              <span class="glide-time">${formatTime(glide.startTime)} → ${formatTime(glide.endTime)}</span>
            </div>
            <div class="glide-stats">
              <span class="glide-stat" title="Glide Ratio"><strong>L/D</strong> ${glideRatioStr}:1</span>
              <span class="glide-stat" title="Speed"><strong>Spd</strong> ${speedStr}</span>
              <span class="glide-stat" title="Altitude Lost"><strong>Alt</strong> -${altLostStr}</span>
              <span class="glide-stat" title="Duration"><strong>Dur</strong> ${formatDuration(glide.duration)}</span>
            </div>
            <div class="glide-altitudes">${startAltStr} → ${endAltStr}</div>
          </div>
        </button>
      `;
    }

    html += '</div>';
    listContainer.innerHTML = html;

    // Add click handlers
    listContainer.querySelectorAll('.glide-item').forEach(item => {
      item.addEventListener('click', () => {
        const glideId = item.getAttribute('data-glide-id');
        const glide = glides.find(g => g.id === glideId);
        if (glide) {
          onEventClick(glide.sourceEvent);
          selectedSegment = glide.segment;
          listContainer.querySelectorAll('.glide-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });
    });

    // Restore selection
    if (selectedSegment) {
      const matchingGlide = glides.find(g =>
        g.segment.startIndex === selectedSegment!.startIndex &&
        g.segment.endIndex === selectedSegment!.endIndex
      );
      if (matchingGlide) {
        const item = listContainer.querySelector(`[data-glide-id="${matchingGlide.id}"]`);
        if (item) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      }
    }
  }

  /**
   * Render climbs list
   */
  function renderClimbs(): void {
    const climbs = extractClimbs();

    if (climbs.length === 0) {
      listContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          ${allEvents.length === 0 ? 'Load an IGC file to see climbs' : 'No thermals detected'}
        </div>
      `;
      eventCountEl.textContent = '0 climbs';
      return;
    }

    eventCountEl.textContent = `${climbs.length} climbs`;

    let html = '<div class="space-y-2">';
    html += '<div class="text-xs text-muted-foreground px-1 pb-2">Sorted by altitude gain (highest first)</div>';

    for (let i = 0; i < climbs.length; i++) {
      const climb = climbs[i];
      const altGainStr = formatAltitude(climb.altitudeGain).withUnit;
      const climbRateStr = formatClimbRate(climb.avgClimbRate).withUnit;
      const startAltStr = formatAltitude(climb.startAltitude).withUnit;
      const endAltStr = formatAltitude(climb.endAltitude).withUnit;

      html += `
        <button class="climb-item" data-climb-id="${climb.id}">
          <div class="climb-rank">#${i + 1}</div>
          <div class="climb-details">
            <div class="climb-primary">
              <span class="climb-gain">+${altGainStr}</span>
              <span class="climb-time">${formatTime(climb.startTime)} → ${formatTime(climb.endTime)}</span>
            </div>
            <div class="climb-stats">
              <span class="climb-stat" title="Average Climb Rate"><strong>Avg</strong> ${climbRateStr}</span>
              <span class="climb-stat" title="Duration"><strong>Dur</strong> ${formatDuration(climb.duration)}</span>
            </div>
            <div class="climb-altitudes">${startAltStr} → ${endAltStr}</div>
          </div>
        </button>
      `;
    }

    html += '</div>';
    listContainer.innerHTML = html;

    // Add click handlers
    listContainer.querySelectorAll('.climb-item').forEach(item => {
      item.addEventListener('click', () => {
        const climbId = item.getAttribute('data-climb-id');
        const climb = climbs.find(c => c.id === climbId);
        if (climb) {
          onEventClick(climb.sourceEvent);
          selectedSegment = climb.segment;
          listContainer.querySelectorAll('.climb-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });
    });

    // Restore selection
    if (selectedSegment) {
      const matchingClimb = climbs.find(c =>
        c.segment.startIndex === selectedSegment!.startIndex &&
        c.segment.endIndex === selectedSegment!.endIndex
      );
      if (matchingClimb) {
        const item = listContainer.querySelector(`[data-climb-id="${matchingClimb.id}"]`);
        if (item) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      }
    }
  }

  /**
   * Render sinks list
   */
  function renderSinks(): void {
    const sinks = extractSinks();

    if (sinks.length === 0) {
      listContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          ${allEvents.length === 0 ? 'Load an IGC file to see sinks' : 'No descents detected'}
        </div>
      `;
      eventCountEl.textContent = '0 sinks';
      return;
    }

    eventCountEl.textContent = `${sinks.length} sinks`;

    let html = '<div class="space-y-2">';
    html += '<div class="text-xs text-muted-foreground px-1 pb-2">Glides with L/D ≤ 5:1, sorted by altitude lost</div>';

    for (let i = 0; i < sinks.length; i++) {
      const sink = sinks[i];
      const distanceStr = formatDistance(sink.distance).withUnit;
      const speedStr = formatSpeed(sink.averageSpeed).withUnit;
      const glideRatioStr = sink.glideRatio > 0 ? sink.glideRatio.toFixed(1) : '0';
      const altLostStr = formatAltitude(sink.altitudeLost).withUnit;
      const sinkRateStr = formatClimbRate(-sink.avgSinkRate).withUnit;
      const startAltStr = formatAltitude(sink.startAltitude).withUnit;
      const endAltStr = formatAltitude(sink.endAltitude).withUnit;

      html += `
        <button class="sink-item" data-sink-id="${sink.id}">
          <div class="sink-rank">#${i + 1}</div>
          <div class="sink-details">
            <div class="sink-primary">
              <span class="sink-drop">-${altLostStr}</span>
              <span class="sink-time">${formatTime(sink.startTime)} → ${formatTime(sink.endTime)}</span>
            </div>
            <div class="sink-stats">
              <span class="sink-stat" title="Glide Ratio"><strong>L/D</strong> ${glideRatioStr}:1</span>
              <span class="sink-stat" title="Average Sink Rate"><strong>Avg</strong> ${sinkRateStr}</span>
              <span class="sink-stat" title="Distance"><strong>Dist</strong> ${distanceStr}</span>
              <span class="sink-stat" title="Speed"><strong>Spd</strong> ${speedStr}</span>
              <span class="sink-stat" title="Duration"><strong>Dur</strong> ${formatDuration(sink.duration)}</span>
            </div>
            <div class="sink-altitudes">${startAltStr} → ${endAltStr}</div>
          </div>
        </button>
      `;
    }

    html += '</div>';
    listContainer.innerHTML = html;

    // Add click handlers
    listContainer.querySelectorAll('.sink-item').forEach(item => {
      item.addEventListener('click', () => {
        const sinkId = item.getAttribute('data-sink-id');
        const sink = sinks.find(s => s.id === sinkId);
        if (sink) {
          onEventClick(sink.sourceEvent);
          selectedSegment = sink.segment;
          listContainer.querySelectorAll('.sink-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });
    });

    // Restore selection
    if (selectedSegment) {
      const matchingSink = sinks.find(s =>
        s.segment.startIndex === selectedSegment!.startIndex &&
        s.segment.endIndex === selectedSegment!.endIndex
      );
      if (matchingSink) {
        const item = listContainer.querySelector(`[data-sink-id="${matchingSink.id}"]`);
        if (item) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      }
    }
  }

  /**
   * Render task turnpoints list
   */
  function renderTask(): void {
    if (!currentTask || currentTask.turnpoints.length === 0) {
      taskListContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          No task loaded
        </div>
      `;
      return;
    }

    const segmentDistances = getOptimizedSegmentDistances(currentTask);

    let html = '<div class="space-y-2">';

    for (let i = 0; i < currentTask.turnpoints.length; i++) {
      const tp = currentTask.turnpoints[i];
      const typeLabel = getTurnpointTypeLabel(tp.type);
      const typeClass = getTurnpointTypeClass(tp.type);
      const radiusStr = formatDistance(tp.radius).withUnit;
      const altStr = tp.waypoint.altSmoothed ? formatAltitude(tp.waypoint.altSmoothed).withUnit : '—';

      // Distance to this turnpoint (sum of previous segments)
      let distanceToHere = 0;
      for (let j = 0; j < i && j < segmentDistances.length; j++) {
        distanceToHere += segmentDistances[j];
      }

      // Distance of the leg TO this turnpoint
      const legDistance = i > 0 && segmentDistances[i - 1] ? segmentDistances[i - 1] : 0;
      const legDistanceStr = i > 0 ? formatDistance(legDistance).withUnit : '—';
      const cumulativeDistStr = i > 0 ? formatDistance(distanceToHere).withUnit : 'Start';

      html += `
        <div class="turnpoint-item rounded-lg border border-border bg-muted/30 p-3">
          <div class="flex items-start gap-3">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium ${typeClass}">
              ${i + 1}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium truncate">${tp.waypoint.name}</span>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs ${typeClass}">${typeLabel}</span>
              </div>
              <div class="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <div class="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
                    <circle cx="12" cy="12" r="10"/>
                  </svg>
                  <span title="Cylinder radius">${radiusStr}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
                    <path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/>
                  </svg>
                  <span title="Altitude">${altStr}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
                    <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/>
                  </svg>
                  <span title="Leg distance">${legDistanceStr}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span title="Cumulative distance">${cumulativeDistStr}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    taskListContainer.innerHTML = html;
  }

  return {
    setEvents(events: FlightEvent[]) {
      allEvents = events;
      updateFilteredEvents();
      if (currentTab === 'track') {
        renderTrack();
      }
    },

    setFlightInfo(info: FlightInfo) {
      const parts: string[] = [];

      if (info.pilot) {
        parts.push(`<strong class="text-foreground">${info.pilot}</strong>`);
      }
      if (info.date) {
        parts.push(info.date);
      }
      if (info.glider) {
        parts.push(info.glider);
      }
      if (info.duration) {
        parts.push(info.duration);
      }
      if (info.maxAlt) {
        parts.push(`Max: ${info.maxAlt}`);
      }
      if (info.task) {
        parts.push(info.task);
      }

      flightInfoEl.innerHTML = parts.length > 0
        ? parts.join(' <span class="mx-1 text-border">|</span> ')
        : 'Load an IGC file to see flight info';
    },

    setTask(task: XCTask | null) {
      currentTask = task;
      if (currentTab === 'task') {
        renderTask();
      }
    },

    clearSelection() {
      selectedSegment = null;
      listContainer.querySelectorAll('.event-item.selected, .glide-item.selected, .climb-item.selected, .sink-item.selected').forEach(el => {
        el.classList.remove('selected');
      });
    },

    toggle() {
      if (isPanelHidden) {
        showPanel();
      } else {
        hidePanel();
      }
    },

    open() {
      if (isPanelHidden) {
        showPanel();
      }
    },

    hide() {
      hidePanel();
    },

    show() {
      showPanel();
    },

    isHidden() {
      return isPanelHidden;
    },

    switchTab(tab: PanelTabType) {
      switchMainTab(tab);
    },

    getCurrentTab(): PanelTabType {
      return currentTab;
    },

    selectByFixIndex(fixIndex: number, selectOptions?: { skipPan?: boolean }) {
      if (allEvents.length === 0) return;

      let matchingEvent: FlightEvent | null = null;
      let eventType: 'glide' | 'climb' | 'sink' | 'event' = 'event';

      // Check glides
      for (const event of allEvents) {
        if (event.type === 'glide_start' && event.segment) {
          if (fixIndex >= event.segment.startIndex && fixIndex <= event.segment.endIndex) {
            matchingEvent = event;
            const details = event.details as { glideRatio?: number } | undefined;
            if (details?.glideRatio !== undefined && details.glideRatio <= 5) {
              eventType = 'sink';
            } else {
              eventType = 'glide';
            }
            break;
          }
        }
      }

      // Check thermals
      if (!matchingEvent) {
        for (const event of allEvents) {
          if (event.type === 'thermal_entry' && event.segment) {
            if (fixIndex >= event.segment.startIndex && fixIndex <= event.segment.endIndex) {
              matchingEvent = event;
              eventType = 'climb';
              break;
            }
          }
        }
      }

      // Find closest point event
      if (!matchingEvent) {
        let minDistance = Infinity;
        for (const event of allEvents) {
          if (event.segment) continue;
          const eventDetails = event.details as { fixIndex?: number } | undefined;
          if (eventDetails?.fixIndex !== undefined) {
            const distance = Math.abs(eventDetails.fixIndex - fixIndex);
            if (distance < minDistance) {
              minDistance = distance;
              matchingEvent = event;
              eventType = 'event';
            }
          }
        }
      }

      if (!matchingEvent && allEvents.length > 0) {
        matchingEvent = allEvents[0];
        eventType = 'event';
      }

      if (matchingEvent) {
        selectedSegment = matchingEvent.segment || null;

        // Switch to track tab and appropriate sub-tab
        if (currentTab !== 'track') {
          switchMainTab('track');
        }

        if (eventType === 'glide') {
          switchTrackTab('glides');
        } else if (eventType === 'climb') {
          switchTrackTab('climbs');
        } else if (eventType === 'sink') {
          switchTrackTab('sinks');
        } else {
          switchTrackTab('all');
        }

        options.onEventClick(matchingEvent, selectOptions?.skipPan ? { skipPan: true } : undefined);
      }
    },

    destroy() {
      panel.remove();
    },
  };
}
