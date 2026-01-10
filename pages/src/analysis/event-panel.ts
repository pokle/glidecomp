/**
 * Event Panel Component
 *
 * A collapsible sidebar panel that displays flight events,
 * filtered by the current map view.
 */

import { FlightEvent, FlightEventType, getEventStyle } from './event-detector';

export interface EventPanelOptions {
  container: HTMLElement;
  onEventClick: (event: FlightEvent) => void;
}

export interface EventPanel {
  setEvents(events: FlightEvent[]): void;
  filterByBounds(bounds: { north: number; south: number; east: number; west: number }): void;
  toggle(): void;
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

  // Create panel structure
  const panel = document.createElement('div');
  panel.className = 'event-panel';
  panel.innerHTML = `
    <div class="event-panel-header">
      <h2>Flight Events</h2>
      <button class="event-panel-toggle" aria-label="Toggle panel">
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
        </svg>
      </button>
    </div>
    <div class="event-panel-filters">
      <label>
        <input type="checkbox" id="filter-view" checked>
        Show only visible events
      </label>
    </div>
    <div class="event-panel-stats">
      <span class="event-count">0 events</span>
    </div>
    <div class="event-panel-list">
      <div class="event-empty">Load an IGC file to see events</div>
    </div>
  `;

  container.appendChild(panel);

  // Get references
  const toggleBtn = panel.querySelector('.event-panel-toggle') as HTMLButtonElement;
  const listContainer = panel.querySelector('.event-panel-list') as HTMLElement;
  const eventCountEl = panel.querySelector('.event-count') as HTMLElement;
  const filterViewCheckbox = panel.querySelector('#filter-view') as HTMLInputElement;

  // State
  let allEvents: FlightEvent[] = [];
  let filteredEvents: FlightEvent[] = [];
  let currentBounds: { north: number; south: number; east: number; west: number } | null = null;
  let isCollapsed = false;

  // Event handlers
  toggleBtn.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    panel.classList.toggle('collapsed', isCollapsed);
    toggleBtn.querySelector('svg')!.style.transform = isCollapsed ? 'rotate(180deg)' : '';
  });

  filterViewCheckbox.addEventListener('change', () => {
    updateFilteredEvents();
    renderEvents();
  });

  /**
   * Update filtered events based on bounds
   */
  function updateFilteredEvents(): void {
    if (!filterViewCheckbox.checked || !currentBounds) {
      filteredEvents = [...allEvents];
    } else {
      filteredEvents = allEvents.filter(event =>
        event.latitude >= currentBounds!.south &&
        event.latitude <= currentBounds!.north &&
        event.longitude >= currentBounds!.west &&
        event.longitude <= currentBounds!.east
      );
    }
  }

  /**
   * Render the event list
   */
  function renderEvents(): void {
    if (filteredEvents.length === 0) {
      listContainer.innerHTML = `
        <div class="event-empty">
          ${allEvents.length === 0 ? 'Load an IGC file to see events' : 'No events in current view'}
        </div>
      `;
      eventCountEl.textContent = `${allEvents.length} events`;
      return;
    }

    eventCountEl.textContent = `${filteredEvents.length} of ${allEvents.length} events`;

    // Group events by category
    const groups: Record<string, FlightEvent[]> = {
      'Key Events': [],
      'Thermals': [],
      'Glides': [],
      'Turnpoints': [],
      'Statistics': [],
    };

    for (const event of filteredEvents) {
      if (event.type === 'takeoff' || event.type === 'landing' ||
          event.type === 'start_crossing' || event.type === 'goal_crossing') {
        groups['Key Events'].push(event);
      } else if (event.type.startsWith('thermal')) {
        groups['Thermals'].push(event);
      } else if (event.type.startsWith('glide')) {
        groups['Glides'].push(event);
      } else if (event.type.startsWith('turnpoint')) {
        groups['Turnpoints'].push(event);
      } else {
        groups['Statistics'].push(event);
      }
    }

    let html = '';

    for (const [groupName, events] of Object.entries(groups)) {
      if (events.length === 0) continue;

      html += `
        <details class="event-group" open>
          <summary class="event-group-header">
            ${groupName}
            <span class="event-group-count">${events.length}</span>
          </summary>
          <div class="event-group-items">
      `;

      for (const event of events) {
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
                ${formatTime(event.time)} | ${event.altitude.toFixed(0)}m
              </span>
            </div>
          </button>
        `;
      }

      html += `
          </div>
        </details>
      `;
    }

    listContainer.innerHTML = html;

    // Add click handlers
    listContainer.querySelectorAll('.event-item').forEach(item => {
      item.addEventListener('click', () => {
        const eventId = item.getAttribute('data-event-id');
        const event = allEvents.find(e => e.id === eventId);
        if (event) {
          onEventClick(event);

          // Highlight selected item
          listContainer.querySelectorAll('.event-item').forEach(el => {
            el.classList.remove('selected');
          });
          item.classList.add('selected');
        }
      });
    });
  }

  return {
    setEvents(events: FlightEvent[]) {
      allEvents = events;
      updateFilteredEvents();
      renderEvents();
    },

    filterByBounds(bounds: { north: number; south: number; east: number; west: number }) {
      currentBounds = bounds;
      updateFilteredEvents();
      renderEvents();
    },

    toggle() {
      isCollapsed = !isCollapsed;
      panel.classList.toggle('collapsed', isCollapsed);
      toggleBtn.querySelector('svg')!.style.transform = isCollapsed ? 'rotate(180deg)' : '';
    },

    destroy() {
      panel.remove();
    },
  };
}
