/**
 * Event Panel Component
 *
 * A sidebar panel that displays flight events,
 * filtered by the current map view.
 * Updated to use Tailwind CSS and Basecoat components.
 */

import { getEventStyle, type FlightEvent, type FlightEventType } from '@taskscore/analysis';
import { formatAltitude, formatSpeed, formatDistance, formatClimbRate } from './units-browser';

/**
 * View modes for the event panel
 */
type ViewMode = 'all' | 'glides' | 'climbs' | 'sinks';

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
  /** Reference to the original glide_start event for click handling */
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
  /** Reference to the original thermal_entry event for click handling */
  sourceEvent: FlightEvent;
}

/**
 * Combined sink/descent data from glide events (sorted by altitude lost)
 * Only includes glides with L/D ratio of 5:1 or worse
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
  /** Reference to the original glide_start event for click handling */
  sourceEvent: FlightEvent;
}

export interface EventPanelOptions {
  container: HTMLElement;
  onEventClick: (event: FlightEvent, options?: { skipPan?: boolean }) => void;
  onToggle?: () => void;
}

export interface FlightInfo {
  date?: string;
  pilot?: string;
  glider?: string;
  duration?: string;
  maxAlt?: string;
  task?: string;
}

export interface EventPanel {
  setEvents(events: FlightEvent[]): void;
  setFlightInfo(info: FlightInfo): void;
  clearSelection(): void;
  toggle(): void;
  open(): void;
  /** Select event by fix index. If skipPan is true, only highlights without panning the map. */
  selectByFixIndex(fixIndex: number, options?: { skipPan?: boolean }): void;
  destroy(): void;
}

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
 * Create the event panel
 */
export function createEventPanel(options: EventPanelOptions): EventPanel {
  const { container, onEventClick } = options;

  // Create panel structure using Tailwind classes
  const panel = document.createElement('div');
  panel.className = 'flex h-full flex-col overflow-hidden';
  panel.innerHTML = `
    <div class="border-b border-border px-4 py-3">
      <h2 class="text-base font-semibold">Flight Events</h2>
    </div>
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
    <div class="event-panel-list flex-1 overflow-y-auto p-2 scrollbar">
      <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
        Load an IGC file to see events
      </div>
    </div>
  `;

  container.appendChild(panel);

  // Get references
  const listContainer = panel.querySelector('.event-panel-list') as HTMLElement;
  const eventCountEl = panel.querySelector('.event-count') as HTMLElement;
  const tabEvents = panel.querySelector('#tab-events') as HTMLButtonElement;
  const tabGlides = panel.querySelector('#tab-glides') as HTMLButtonElement;
  const tabClimbs = panel.querySelector('#tab-climbs') as HTMLButtonElement;
  const tabSinks = panel.querySelector('#tab-sinks') as HTMLButtonElement;
  const allTabs = [tabEvents, tabGlides, tabClimbs, tabSinks];
  const flightInfoEl = panel.querySelector('.flight-info-content') as HTMLElement;

  // State
  let allEvents: FlightEvent[] = [];
  let filteredEvents: FlightEvent[] = [];
  let isCollapsed = false;
  let viewMode: ViewMode = 'all';
  // Track selected segment for cross-tab synchronization
  let selectedSegment: { startIndex: number; endIndex: number } | null = null;

  /**
   * Switch to a tab and update UI
   */
  function switchTab(mode: ViewMode): void {
    viewMode = mode;

    // Update tab states (Basecoat uses aria-selected for styling)
    for (const tab of allTabs) {
      if (tab) {
        tab.setAttribute('aria-selected', 'false');
      }
    }

    // Select the active tab
    let activeTab: HTMLButtonElement | null = null;
    if (mode === 'all') {
      activeTab = tabEvents;
    } else if (mode === 'glides') {
      activeTab = tabGlides;
    } else if (mode === 'climbs') {
      activeTab = tabClimbs;
    } else if (mode === 'sinks') {
      activeTab = tabSinks;
    }
    if (activeTab) {
      activeTab.setAttribute('aria-selected', 'true');
    }

    render();

    // Reset scroll position when switching tabs (unless we have a selection that will scroll into view)
    if (!selectedSegment) {
      listContainer.scrollTop = 0;
    }
  }

  // Tab click handlers
  tabEvents?.addEventListener('click', () => switchTab('all'));
  tabGlides?.addEventListener('click', () => switchTab('glides'));
  tabClimbs?.addEventListener('click', () => switchTab('climbs'));
  tabSinks?.addEventListener('click', () => switchTab('sinks'));

  /**
   * Update filtered events (currently shows all events)
   */
  function updateFilteredEvents(): void {
    filteredEvents = [...allEvents];
  }

  /**
   * Extract combined glide data from glide_start events
   * Each glide_start contains all the info we need
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

        // Find matching glide_end event
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

    // Sort by distance (longest first)
    glides.sort((a, b) => b.distance - a.distance);

    return glides;
  }

  /**
   * Extract combined climb/thermal data from thermal_entry events
   * Each thermal_entry contains all the info we need
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

        // Find matching thermal_exit event
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

    // Sort by altitude gain (highest first)
    climbs.sort((a, b) => b.altitudeGain - a.altitudeGain);

    return climbs;
  }

  /**
   * Extract sink/descent data from glide events (sorted by altitude lost)
   * Sinks are glides with poor L/D ratio (5:1 or worse), indicating strong sink
   */
  function extractSinks(): SinkData[] {
    const sinks: SinkData[] = [];
    const maxGlideRatioForSink = 5; // L/D of 5:1 or worse qualifies as a sink

    for (const event of allEvents) {
      if (event.type === 'glide_start' && event.segment && event.details) {
        const details = event.details as {
          distance?: number;
          averageSpeed?: number;
          glideRatio?: number;
          duration?: number;
        };

        const glideRatio = details.glideRatio || 0;

        // Only include glides with L/D of 5:1 or worse (lower is worse)
        if (glideRatio > maxGlideRatioForSink) {
          continue;
        }

        // Find matching glide_end event
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

    // Sort by altitude lost (deepest first)
    sinks.sort((a, b) => b.altitudeLost - a.altitudeLost);

    return sinks;
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
   * Main render function that delegates to the appropriate view
   */
  function render(): void {
    if (viewMode === 'glides') {
      renderGlides();
    } else if (viewMode === 'climbs') {
      renderClimbs();
    } else if (viewMode === 'sinks') {
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

    // Render events as a timeline
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

          // Store selected segment for cross-tab sync
          selectedSegment = event.segment || null;

          // Highlight selected item
          listContainer.querySelectorAll('.event-item').forEach(el => {
            el.classList.remove('selected');
          });
          item.classList.add('selected');
        }
      });
    });

    // Restore selection if there's a selected segment
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
   * Render the glides list (longest first)
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

    // Render glides with detailed stats
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
              <span class="glide-stat" title="Glide Ratio">
                <strong>L/D</strong> ${glideRatioStr}:1
              </span>
              <span class="glide-stat" title="Speed">
                <strong>Spd</strong> ${speedStr}
              </span>
              <span class="glide-stat" title="Altitude Lost">
                <strong>Alt</strong> -${altLostStr}
              </span>
              <span class="glide-stat" title="Duration">
                <strong>Dur</strong> ${formatDuration(glide.duration)}
              </span>
            </div>
            <div class="glide-altitudes">
              ${startAltStr} → ${endAltStr}
            </div>
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

          // Store selected segment for cross-tab sync
          selectedSegment = glide.segment;

          // Highlight selected item
          listContainer.querySelectorAll('.glide-item').forEach(el => {
            el.classList.remove('selected');
          });
          item.classList.add('selected');
        }
      });
    });

    // Restore selection if there's a selected segment
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
   * Render the climbs list (highest altitude gain first)
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

    // Render climbs with detailed stats
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
              <span class="climb-stat" title="Average Climb Rate">
                <strong>Avg</strong> ${climbRateStr}
              </span>
              <span class="climb-stat" title="Duration">
                <strong>Dur</strong> ${formatDuration(climb.duration)}
              </span>
            </div>
            <div class="climb-altitudes">
              ${startAltStr} → ${endAltStr}
            </div>
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

          // Store selected segment for cross-tab sync
          selectedSegment = climb.segment;

          // Highlight selected item
          listContainer.querySelectorAll('.climb-item').forEach(el => {
            el.classList.remove('selected');
          });
          item.classList.add('selected');
        }
      });
    });

    // Restore selection if there's a selected segment
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
   * Render the sinks list (deepest altitude drop first)
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

    // Render sinks with detailed stats
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
              <span class="sink-stat" title="Glide Ratio">
                <strong>L/D</strong> ${glideRatioStr}:1
              </span>
              <span class="sink-stat" title="Average Sink Rate">
                <strong>Avg</strong> ${sinkRateStr}
              </span>
              <span class="sink-stat" title="Distance">
                <strong>Dist</strong> ${distanceStr}
              </span>
              <span class="sink-stat" title="Speed">
                <strong>Spd</strong> ${speedStr}
              </span>
              <span class="sink-stat" title="Duration">
                <strong>Dur</strong> ${formatDuration(sink.duration)}
              </span>
            </div>
            <div class="sink-altitudes">
              ${startAltStr} → ${endAltStr}
            </div>
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

          // Store selected segment for cross-tab sync
          selectedSegment = sink.segment;

          // Highlight selected item
          listContainer.querySelectorAll('.sink-item').forEach(el => {
            el.classList.remove('selected');
          });
          item.classList.add('selected');
        }
      });
    });

    // Restore selection if there's a selected segment
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

  return {
    setEvents(events: FlightEvent[]) {
      allEvents = events;
      updateFilteredEvents();
      render();
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

    clearSelection() {
      selectedSegment = null;
      listContainer.querySelectorAll('.event-item.selected, .glide-item.selected, .climb-item.selected, .sink-item.selected').forEach(el => {
        el.classList.remove('selected');
      });
    },

    toggle() {
      isCollapsed = !isCollapsed;
      container.classList.toggle('hidden', isCollapsed);

      if (options.onToggle) {
        setTimeout(options.onToggle, 350);
      }
    },

    open() {
      if (isCollapsed) {
        isCollapsed = false;
        container.classList.remove('hidden');

        if (options.onToggle) {
          setTimeout(options.onToggle, 350);
        }
      }
    },

    selectByFixIndex(fixIndex: number, selectOptions?: { skipPan?: boolean }) {
      if (allEvents.length === 0) return;

      // Find event whose segment contains this fix index
      let matchingEvent: FlightEvent | null = null;
      let eventType: 'glide' | 'climb' | 'sink' | 'event' = 'event';

      // Check glides (glide_start events)
      for (const event of allEvents) {
        if (event.type === 'glide_start' && event.segment) {
          if (fixIndex >= event.segment.startIndex && fixIndex <= event.segment.endIndex) {
            matchingEvent = event;
            // Check if it's a sink (poor L/D ratio <= 5)
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

      // Check thermals (thermal_entry events)
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

      // If no segment match, find closest point event by index
      if (!matchingEvent) {
        let minDistance = Infinity;
        for (const event of allEvents) {
          // Skip segment events, we want point events
          if (event.segment) continue;

          // For point events, we need to find the closest one
          // We'll use the event's index if available in details, otherwise skip
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

      // If still no match, just use the first event
      if (!matchingEvent && allEvents.length > 0) {
        matchingEvent = allEvents[0];
        eventType = 'event';
      }

      if (matchingEvent) {
        // Set the selected segment if available
        selectedSegment = matchingEvent.segment || null;

        // Switch to appropriate tab
        if (eventType === 'glide') {
          switchTab('glides');
        } else if (eventType === 'climb') {
          switchTab('climbs');
        } else if (eventType === 'sink') {
          switchTab('sinks');
        } else {
          switchTab('all');
        }

        // Trigger the event click callback with skipPan option if provided
        options.onEventClick(matchingEvent, selectOptions?.skipPan ? { skipPan: true } : undefined);
      }
    },

    destroy() {
      panel.remove();
    },
  };
}
