/**
 * Analysis Panel Component
 *
 * Main tabbed panel with Track, Task, and Terrain tabs.
 * Provides a unified interface for flight analysis data.
 */

import { getEventStyle, getOptimizedSegmentDistances, resolveTurnpointSequence, type FlightEvent, type FlightEventType, type XCTask, type TurnpointSequenceResult } from '@taskscore/analysis';
import { formatAltitude, formatSpeed, formatDistance, formatClimbRate } from './units-browser';

/**
 * Unified panel tabs
 */
export type PanelTabType = 'task' | 'score' | 'events' | 'glides' | 'climbs' | 'sinks';

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
  onTurnpointClick?: (turnpointIndex: number) => void;
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
  setScore(result: TurnpointSequenceResult | null): void;
  setAltitudes(altitudes: number[], timestamps?: Date[]): void;
  clearSelection(): void;
  toggle(): void;
  open(): void;
  hide(): void;
  show(): void;
  isHidden(): boolean;
  switchTab(tab: PanelTabType): void;
  getCurrentTab(): PanelTabType;
  selectByFixIndex(fixIndex: number, options?: { skipPan?: boolean }): void;
  selectTurnpoint(turnpointIndex: number): void;
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
    start_reaching: 'Start (scored)',
    turnpoint_reaching: 'TP Reached',
    ess_reaching: 'ESS Reached',
    goal_reaching: 'Goal Reached',
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
 * Generate an SVG altitude sparkline (area chart) from an array of altitude values.
 * Returns an SVG string with a vertical gradient fill matching the track altitude colors.
 */
function generateAltitudeSparkline(altitudes: number[]): string {
  if (altitudes.length < 2) return '';

  // Downsample to ~200 points for performance
  const maxPoints = 200;
  const step = Math.max(1, Math.floor(altitudes.length / maxPoints));
  const sampled: number[] = [];
  for (let i = 0; i < altitudes.length; i += step) {
    sampled.push(altitudes[i]);
  }
  if (sampled[sampled.length - 1] !== altitudes[altitudes.length - 1]) {
    sampled.push(altitudes[altitudes.length - 1]);
  }

  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const a of sampled) {
    if (a < minAlt) minAlt = a;
    if (a > maxAlt) maxAlt = a;
  }
  const altRange = maxAlt - minAlt || 1;

  const w = sampled.length - 1;
  const h = 100;

  // Build area path: altitude line then close to bottom
  let path = `M0,${h}`;
  for (let i = 0; i < sampled.length; i++) {
    const x = (i / (sampled.length - 1)) * w;
    const y = h - ((sampled[i] - minAlt) / altRange) * h;
    path += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  path += ` L${w},${h} Z`;

  // Vertical gradient: same color stops as getAltitudeColorNormalized
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="ag" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="rgb(139,90,43)"/><stop offset="25%" stop-color="rgb(67,160,71)"/><stop offset="50%" stop-color="rgb(3,155,229)"/><stop offset="75%" stop-color="rgb(41,182,246)"/><stop offset="100%" stop-color="rgb(79,195,247)"/></linearGradient></defs><path d="${path}" fill="url(#ag)" opacity="0.4"/></svg>`;
}

/**
 * Create the analysis panel
 */
export function createAnalysisPanel(options: AnalysisPanelOptions): AnalysisPanel {
  const { container, onEventClick } = options;

  // Create panel structure with unified tab row
  const panel = document.createElement('div');
  panel.className = 'flex h-full flex-col overflow-hidden';
  panel.innerHTML = `
    <!-- Flight info banner -->
    <div class="border-b border-border bg-muted/50 px-4 py-2 text-sm">
      <div class="flight-info-content text-muted-foreground">Load an IGC file to see flight info</div>
    </div>

    <!-- Unified tab row -->
    <div class="tabs w-full border-b border-border">
      <nav role="tablist" class="w-full">
        <button type="button" role="tab" id="tab-task" aria-selected="false">Task</button>
        <button type="button" role="tab" id="tab-score" aria-selected="false">Score</button>
        <button type="button" role="tab" id="tab-events" aria-selected="true">Events</button>
        <button type="button" role="tab" id="tab-glides" aria-selected="false">Glides</button>
        <button type="button" role="tab" id="tab-climbs" aria-selected="false">Climbs</button>
        <button type="button" role="tab" id="tab-sinks" aria-selected="false">Sinks</button>
      </nav>
    </div>

    <!-- Count bar -->
    <div class="border-b border-border px-4 py-1.5 text-sm text-muted-foreground">
      <span class="event-count">0 events</span>
    </div>

    <!-- Altitude sparkline (fixed above scrollable list) -->
    <div id="sparkline-container" class="hidden border-b border-border" style="height: 88px; min-height: 88px;">
      <div style="position: relative; width: 100%; height: 100%; padding-left: 32px; padding-bottom: 16px; box-sizing: border-box;">
        <div id="sparkline-inner" style="width: 100%; height: 100%; position: relative;"></div>
        <div id="sparkline-y-axis" style="position: absolute; left: 0; top: 0; bottom: 16px; width: 32px; pointer-events: none; overflow: hidden;"></div>
        <div id="sparkline-x-axis" style="position: absolute; left: 32px; right: 0; bottom: 0; height: 16px; pointer-events: none; overflow: hidden;"></div>
      </div>
    </div>

    <!-- Track content (Events, Glides, Climbs, Sinks) -->
    <div id="track-panel-content" class="track-list flex-1 overflow-y-auto p-2 scrollbar">
      <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
        Load an IGC file to see events
      </div>
    </div>

    <!-- Task content (turnpoints list) -->
    <div id="task-panel-content" class="hidden task-list flex-1 overflow-y-auto p-2 scrollbar">
      <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
        No task loaded
      </div>
    </div>

    <!-- Score content -->
    <div id="score-panel-content" class="hidden score-list flex-1 overflow-y-auto p-2 scrollbar">
      <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
        Load a task and track to see scoring
      </div>
    </div>
  `;

  container.appendChild(panel);

  // Get references
  const trackPanelContent = panel.querySelector('#track-panel-content') as HTMLElement;
  const taskPanelContent = panel.querySelector('#task-panel-content') as HTMLElement;
  const scorePanelContent = panel.querySelector('#score-panel-content') as HTMLElement;
  const sparklineContainer = panel.querySelector('#sparkline-container') as HTMLElement;
  const sparklineInner = panel.querySelector('#sparkline-inner') as HTMLElement;
  const sparklineYAxis = panel.querySelector('#sparkline-y-axis') as HTMLElement;
  const sparklineXAxis = panel.querySelector('#sparkline-x-axis') as HTMLElement;

  const listContainer = trackPanelContent;
  const eventCountEl = panel.querySelector('.event-count') as HTMLElement;
  const taskListContainer = panel.querySelector('#task-panel-content') as HTMLElement;

  const tabTask = panel.querySelector('#tab-task') as HTMLButtonElement;
  const tabScore = panel.querySelector('#tab-score') as HTMLButtonElement;
  const tabEvents = panel.querySelector('#tab-events') as HTMLButtonElement;
  const tabGlides = panel.querySelector('#tab-glides') as HTMLButtonElement;
  const tabClimbs = panel.querySelector('#tab-climbs') as HTMLButtonElement;
  const tabSinks = panel.querySelector('#tab-sinks') as HTMLButtonElement;
  const allTabs = [tabTask, tabScore, tabEvents, tabGlides, tabClimbs, tabSinks];

  const flightInfoEl = panel.querySelector('.flight-info-content') as HTMLElement;

  // State
  let allEvents: FlightEvent[] = [];
  let filteredEvents: FlightEvent[] = [];
  let currentTask: XCTask | null = null;
  let isPanelHidden = true;
  const TAB_STORAGE_KEY = 'taskscore-active-tab';
  const validTabs: PanelTabType[] = ['task', 'score', 'events', 'glides', 'climbs', 'sinks'];
  const savedTab = localStorage.getItem(TAB_STORAGE_KEY) as PanelTabType | null;
  let currentTab: PanelTabType = savedTab && validTabs.includes(savedTab) ? savedTab : 'events';
  let selectedSegment: { startIndex: number; endIndex: number } | null = null;
  let selectedTurnpointIndex: number | null = null;
  let currentScore: TurnpointSequenceResult | null = null;
  let sparklineDataUri = '';
  let fixCount = 0;

  /**
   * Format a time as HH:MM (24h, local timezone to match event list)
   */
  function formatTimeShort(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  /**
   * Render Y-axis (altitude) labels with tick marks
   */
  function renderYAxisLabels(minAlt: number, maxAlt: number): void {
    sparklineYAxis.innerHTML = '';
    const range = maxAlt - minAlt;
    if (range <= 0) return;

    // Pick 2-3 nice round values between min and max
    const niceStep = niceAxisStep(range, 3);
    const firstTick = Math.ceil(minAlt / niceStep) * niceStep;

    for (let val = firstTick; val <= maxAlt; val += niceStep) {
      const pct = ((val - minAlt) / range) * 100;
      // pct=0 is bottom, pct=100 is top; CSS bottom percentage
      const label = document.createElement('div');
      label.style.cssText = `position: absolute; right: 2px; bottom: ${pct}%; transform: translateY(50%); font-size: 9px; line-height: 1; color: var(--color-muted-foreground); display: flex; align-items: center; gap: 1px;`;
      const fv = formatAltitude(val);
      label.innerHTML = `<span>${fv.formatted}</span><span style="width: 4px; height: 1px; background: var(--color-muted-foreground); display: inline-block; flex-shrink: 0;"></span>`;
      sparklineYAxis.appendChild(label);
    }
  }

  /**
   * Render X-axis (time) labels with tick marks
   */
  function renderXAxisLabels(timestamps: Date[]): void {
    sparklineXAxis.innerHTML = '';
    if (timestamps.length < 2) return;

    const startMs = timestamps[0].getTime();
    const endMs = timestamps[timestamps.length - 1].getTime();
    const durationMs = endMs - startMs;
    if (durationMs <= 0) return;

    // Pick ~3-5 evenly-spaced time ticks at nice intervals
    const durationMin = durationMs / 60000;
    const stepMin = niceTimeStep(durationMin, 4);
    const stepMs = stepMin * 60000;

    // Snap first tick to next multiple of stepMin from start (local timezone)
    const startMinOfDay = timestamps[0].getHours() * 60 + timestamps[0].getMinutes();
    const firstTickMin = Math.ceil(startMinOfDay / stepMin) * stepMin;
    const firstTickMs = timestamps[0].getTime() - startMinOfDay * 60000 + firstTickMin * 60000;

    for (let tickMs = firstTickMs; tickMs <= endMs; tickMs += stepMs) {
      if (tickMs < startMs) continue;
      const pct = ((tickMs - startMs) / durationMs) * 100;
      const label = document.createElement('div');
      label.style.cssText = `position: absolute; left: ${pct}%; top: 0; transform: translateX(-50%); font-size: 9px; line-height: 1; color: var(--color-muted-foreground); display: flex; flex-direction: column; align-items: center;`;
      const tickDate = new Date(tickMs);
      label.innerHTML = `<span style="width: 1px; height: 4px; background: var(--color-muted-foreground); display: block;"></span><span>${formatTimeShort(tickDate)}</span>`;
      sparklineXAxis.appendChild(label);
    }
  }

  /**
   * Compute a nice round step for altitude axis given range and desired ~count ticks
   */
  function niceAxisStep(range: number, targetTicks: number): number {
    const rough = range / targetTicks;
    // Convert to current altitude unit for nice rounding, then back
    const fv = formatAltitude(rough);
    const unitValue = fv.value;
    const magnitude = Math.pow(10, Math.floor(Math.log10(unitValue)));
    const residual = unitValue / magnitude;
    let nice: number;
    if (residual <= 1.5) nice = 1;
    else if (residual <= 3.5) nice = 2;
    else if (residual <= 7.5) nice = 5;
    else nice = 10;
    const niceUnitValue = nice * magnitude;
    // Convert back to meters: niceUnitValue / fv.value * rough
    return (niceUnitValue / unitValue) * rough;
  }

  /**
   * Compute a nice time step in minutes for ~targetTicks ticks
   */
  function niceTimeStep(durationMinutes: number, targetTicks: number): number {
    const rough = durationMinutes / targetTicks;
    const steps = [5, 10, 15, 20, 30, 60, 120, 180, 240];
    for (const s of steps) {
      if (s >= rough) return s;
    }
    return 240;
  }

  /**
   * Apply altitude sparkline into the dedicated sparkline container
   */
  function applySparklineBackground(altitudes: number[], timestamps?: Date[]): void {
    fixCount = altitudes.length;
    const svg = generateAltitudeSparkline(altitudes);
    if (svg) {
      sparklineDataUri = `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
      sparklineInner.style.backgroundImage = sparklineDataUri;
      sparklineInner.style.backgroundSize = '100% 100%';
      sparklineInner.style.backgroundRepeat = 'no-repeat';
      // Only show sparkline on track tabs (events/glides/climbs/sinks)
      if (currentTab !== 'task' && currentTab !== 'score') {
        sparklineContainer.classList.remove('hidden');
      }

      // Compute min/max for Y labels
      let minAlt = Infinity;
      let maxAlt = -Infinity;
      for (const a of altitudes) {
        if (a < minAlt) minAlt = a;
        if (a > maxAlt) maxAlt = a;
      }
      renderYAxisLabels(minAlt, maxAlt);

      if (timestamps && timestamps.length >= 2) {
        renderXAxisLabels(timestamps);
      }
    } else {
      sparklineDataUri = '';
      sparklineInner.style.backgroundImage = '';
      sparklineYAxis.innerHTML = '';
      sparklineXAxis.innerHTML = '';
      sparklineContainer.classList.add('hidden');
    }
  }

  /**
   * Get the fix index for an event (segment start or point fixIndex)
   */
  function getEventFixIndex(event: FlightEvent): number | null {
    if (event.segment) return event.segment.startIndex;
    const details = event.details as { fixIndex?: number } | undefined;
    return details?.fixIndex ?? null;
  }

  /**
   * Update the sparkline with a vertical marker line at the given fix index
   */
  function updateSparklineMarker(fixIndex: number | null): void {
    if (!sparklineDataUri) return;

    if (fixIndex === null || fixCount < 2) {
      sparklineInner.style.backgroundImage = sparklineDataUri;
      sparklineInner.style.backgroundSize = '100% 100%';
      sparklineInner.style.backgroundRepeat = 'no-repeat';
      return;
    }

    const p = (fixIndex / (fixCount - 1)) * 100;
    const glow = `linear-gradient(to right, transparent calc(${p.toFixed(2)}% - 12px), rgba(249,115,22,0.15) calc(${p.toFixed(2)}% - 4px), rgba(249,115,22,0.9) calc(${p.toFixed(2)}% - 1px), rgb(249,115,22) calc(${p.toFixed(2)}%), rgba(249,115,22,0.9) calc(${p.toFixed(2)}% + 1px), rgba(249,115,22,0.15) calc(${p.toFixed(2)}% + 4px), transparent calc(${p.toFixed(2)}% + 12px))`;
    sparklineInner.style.backgroundImage = `${glow}, ${sparklineDataUri}`;
    sparklineInner.style.backgroundSize = '100% 100%, 100% 100%';
    sparklineInner.style.backgroundRepeat = 'no-repeat, no-repeat';
  }

  /**
   * Switch to a tab (unified tab system)
   */
  function switchTabInternal(tab: PanelTabType): void {
    currentTab = tab;
    localStorage.setItem(TAB_STORAGE_KEY, tab);

    // Update tab visual states
    for (const t of allTabs) {
      if (t) t.setAttribute('aria-selected', 'false');
    }
    const tabMap: Record<PanelTabType, HTMLButtonElement | null> = {
      task: tabTask,
      score: tabScore,
      events: tabEvents,
      glides: tabGlides,
      climbs: tabClimbs,
      sinks: tabSinks,
    };
    tabMap[tab]?.setAttribute('aria-selected', 'true');

    // Show appropriate content panel
    if (tab === 'task') {
      trackPanelContent.classList.add('hidden');
      scorePanelContent.classList.add('hidden');
      sparklineContainer.classList.add('hidden');
      taskPanelContent.classList.remove('hidden');
      renderTask();
    } else if (tab === 'score') {
      trackPanelContent.classList.add('hidden');
      taskPanelContent.classList.add('hidden');
      sparklineContainer.classList.add('hidden');
      scorePanelContent.classList.remove('hidden');
      renderScore();
    } else {
      taskPanelContent.classList.add('hidden');
      scorePanelContent.classList.add('hidden');
      trackPanelContent.classList.remove('hidden');
      // Show sparkline if we have data
      if (sparklineDataUri) {
        sparklineContainer.classList.remove('hidden');
      }
      renderTrack();
      if (!selectedSegment) {
        listContainer.scrollTop = 0;
      }
    }
  }

  // Tab click handlers
  tabTask?.addEventListener('click', () => switchTabInternal('task'));
  tabScore?.addEventListener('click', () => switchTabInternal('score'));
  tabEvents?.addEventListener('click', () => switchTabInternal('events'));
  tabGlides?.addEventListener('click', () => switchTabInternal('glides'));
  tabClimbs?.addEventListener('click', () => switchTabInternal('climbs'));
  tabSinks?.addEventListener('click', () => switchTabInternal('sinks'));

  // Restore saved tab
  if (currentTab !== 'events') {
    switchTabInternal(currentTab);
  }

  // Sparkline click handler - select nearest event for the current tab
  sparklineInner.addEventListener('click', (e: MouseEvent) => {
    if (fixCount < 2 || allEvents.length === 0) return;
    const rect = sparklineInner.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fixIndex = Math.round((x / rect.width) * (fixCount - 1));
    selectNearestForCurrentTab(fixIndex);
  });
  sparklineInner.style.cursor = 'crosshair';

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
   * Event types to hide from the event list (raw crossings are
   * superseded by the scored reaching events).
   */
  const hiddenEventTypes: Set<FlightEventType> = new Set([
    'turnpoint_entry',
    'turnpoint_exit',
    'start_crossing',
    'goal_crossing',
  ]);

  /**
   * Update filtered events
   */
  function updateFilteredEvents(): void {
    filteredEvents = allEvents.filter(e => !hiddenEventTypes.has(e.type));
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
    if (currentTab === 'glides') {
      renderGlides();
    } else if (currentTab === 'climbs') {
      renderClimbs();
    } else if (currentTab === 'sinks') {
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
          updateSparklineMarker(getEventFixIndex(event));
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
          updateSparklineMarker(glide.segment.startIndex);
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
          updateSparklineMarker(climb.segment.startIndex);
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
          updateSparklineMarker(sink.segment.startIndex);
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
   * Format seconds as HH:MM:SS
   */
  function formatHMS(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Get human-readable label for a turnpoint by task index
   */
  function getTurnpointLabel(taskIndex: number): string {
    if (!currentTask) return `TP${taskIndex + 1}`;
    const tp = currentTask.turnpoints[taskIndex];
    if (!tp) return `TP${taskIndex + 1}`;
    if (tp.type === 'SSS') return 'SSS';
    if (tp.type === 'ESS') return 'ESS';
    if (taskIndex === currentTask.turnpoints.length - 1) return 'Goal';
    return `TP${taskIndex + 1}`;
  }

  /**
   * Render the Score panel content
   */
  function renderScore(): void {
    if (!currentScore || !currentTask) {
      eventCountEl.textContent = 'No score';
      scorePanelContent.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          Load a task and track to see scoring
        </div>
      `;
      return;
    }

    const result = currentScore;
    eventCountEl.textContent = result.madeGoal ? 'Goal' : result.sequence.length > 0 ? `${result.sequence.length} TPs reached` : 'Not started';

    let html = '<div class="space-y-3">';

    // A. Status banner
    if (result.madeGoal) {
      html += `<div class="rounded-lg bg-green-500/15 px-3 py-2 text-sm font-medium text-green-700 dark:text-green-400">Goal</div>`;
    } else if (result.sequence.length > 0) {
      const lastTP = result.sequence[result.sequence.length - 1];
      const tpName = currentTask.turnpoints[lastTP.taskIndex]?.waypoint.name || getTurnpointLabel(lastTP.taskIndex);
      html += `<div class="rounded-lg bg-yellow-500/15 px-3 py-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">${getTurnpointLabel(lastTP.taskIndex)} reached &ndash; ${tpName}</div>`;
    } else {
      html += `<div class="rounded-lg bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">Not started</div>`;
    }

    // B. Distance bar
    // For non-goal pilots, show completed leg distance (sum of completed legs)
    // rather than the CIVL GAP flownDistance which can be misleading
    const completedLegs = result.legs.filter(l => l.completed);
    const completedLegDistance = completedLegs.reduce((sum, l) => sum + l.distance, 0);
    const displayDistance = result.madeGoal ? result.taskDistance : completedLegDistance;
    const flownStr = formatDistance(displayDistance).withUnit;
    const taskStr = formatDistance(result.taskDistance).withUnit;
    const pct = result.taskDistance > 0 ? Math.min(100, (displayDistance / result.taskDistance) * 100) : 0;

    html += `
      <div class="rounded-lg border border-border bg-muted/30 p-3">
        <div class="flex items-baseline justify-between text-sm">
          <span>${flownStr} / ${taskStr}</span>
          <span class="font-medium">${pct.toFixed(0)}%</span>
        </div>
        <div class="mt-1.5 h-2 rounded-full bg-muted overflow-hidden">
          <div class="h-full rounded-full bg-primary transition-all" style="width: ${pct.toFixed(1)}%"></div>
        </div>
        <div class="text-xs text-muted-foreground mt-1">${completedLegs.length} of ${result.legs.length} legs completed</div>
      </div>
    `;

    // C. Speed section
    if (result.speedSectionTime !== null) {
      html += `
        <div class="rounded-lg border border-border bg-muted/30 p-3">
          <div class="text-xs text-muted-foreground mb-1">Speed section</div>
          <div class="text-sm font-medium">${formatHMS(result.speedSectionTime)}</div>
        </div>
      `;
    }

    // D. Legs
    html += `<div class="rounded-lg border border-border bg-muted/30 p-3">`;
    html += `<div class="text-xs text-muted-foreground mb-2">Legs</div>`;
    for (const leg of result.legs) {
      const fromName = getTurnpointLabel(leg.fromTaskIndex);
      const toName = getTurnpointLabel(leg.toTaskIndex);
      const legDist = formatDistance(leg.distance).withUnit;
      const icon = leg.completed
        ? '<span class="text-green-600 dark:text-green-400">&#10003;</span>'
        : '<span class="text-muted-foreground">&#10007;</span>';
      html += `
        <div class="flex items-center justify-between py-1 text-sm">
          <span>${fromName} &rarr; ${toName}</span>
          <span class="flex items-center gap-2"><span class="text-muted-foreground">${legDist}</span>${icon}</span>
        </div>
      `;
    }
    html += `</div>`;

    // E. Sequence (reachings)
    if (result.sequence.length > 0) {
      html += `<div class="rounded-lg border border-border bg-muted/30 p-3">`;
      html += `<div class="text-xs text-muted-foreground mb-2">Sequence</div>`;
      for (const reaching of result.sequence) {
        const tp = currentTask.turnpoints[reaching.taskIndex];
        const tpLabel = getTurnpointLabel(reaching.taskIndex);
        const tpName = tp?.waypoint.name || tpLabel;
        const timeStr = formatTime(reaching.time);
        const altStr = formatAltitude(reaching.altitude).withUnit;

        let reasonStr = '';
        if (reaching.selectionReason === 'last_before_next' && reaching.candidateCount > 1) {
          reasonStr = `Last of ${reaching.candidateCount} crossings`;
        } else if (reaching.selectionReason === 'last_before_next') {
          reasonStr = 'Start';
        } else if (reaching.selectionReason === 'first_after_previous' && reaching.candidateCount > 1) {
          reasonStr = `First of ${reaching.candidateCount} crossings`;
        } else if (reaching.selectionReason === 'first_crossing' && reaching.candidateCount > 1) {
          reasonStr = `First of ${reaching.candidateCount} crossings`;
        }

        html += `
          <button class="score-reaching-item w-full text-left py-1.5 cursor-pointer hover:bg-muted/50 rounded transition-colors" data-reaching-idx="${reaching.taskIndex}" data-lat="${reaching.latitude}" data-lon="${reaching.longitude}" data-alt="${reaching.altitude}" data-time="${reaching.time.getTime()}">
            <div class="flex items-baseline gap-2 text-sm">
              <span class="shrink-0 text-muted-foreground">${timeStr}</span>
              <span class="font-medium">${tpLabel}</span>
              <span class="truncate text-muted-foreground">${tpName}</span>
              <span class="ml-auto shrink-0 text-muted-foreground">${altStr}</span>
            </div>
            ${reasonStr ? `<div class="text-xs text-muted-foreground mt-0.5 pl-[4.5rem]">${reasonStr}</div>` : ''}
          </button>
        `;
      }
      html += `</div>`;
    }

    // F. Best progress (non-goal only)
    if (!result.madeGoal && result.bestProgress) {
      const distToGoalStr = formatDistance(result.bestProgress.distanceToGoal).withUnit;
      const creditStr = formatDistance(result.flownDistance).withUnit;
      const timeStr = formatTime(result.bestProgress.time);
      html += `
        <button class="score-best-progress w-full rounded-lg border border-border bg-muted/30 p-3 text-left cursor-pointer hover:bg-muted/50 transition-colors" data-lat="${result.bestProgress.latitude}" data-lon="${result.bestProgress.longitude}" data-time="${result.bestProgress.time.getTime()}">
          <div class="text-xs text-muted-foreground mb-1">Best progress</div>
          <div class="text-sm">${distToGoalStr} from goal at ${timeStr}</div>
          <div class="text-xs text-muted-foreground mt-1">Distance credit: ${creditStr}</div>
        </button>
      `;
    }

    html += '</div>';
    scorePanelContent.innerHTML = html;

    // Click handlers for reachings
    scorePanelContent.querySelectorAll('.score-reaching-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat(item.getAttribute('data-lat') || '0');
        const lon = parseFloat(item.getAttribute('data-lon') || '0');
        const alt = parseFloat(item.getAttribute('data-alt') || '0');
        const time = new Date(parseInt(item.getAttribute('data-time') || '0', 10));
        const idx = parseInt(item.getAttribute('data-reaching-idx') || '0', 10);
        const syntheticEvent: FlightEvent = {
          id: `score-reaching-${idx}`,
          type: 'turnpoint_reaching',
          time,
          latitude: lat,
          longitude: lon,
          altitude: alt,
          description: '',
        };
        onEventClick(syntheticEvent);
      });
    });

    // Click handler for best progress
    const bpEl = scorePanelContent.querySelector('.score-best-progress');
    if (bpEl && result.bestProgress) {
      bpEl.addEventListener('click', () => {
        const bp = result.bestProgress!;
        const syntheticEvent: FlightEvent = {
          id: 'score-best-progress',
          type: 'max_altitude',
          time: bp.time,
          latitude: bp.latitude,
          longitude: bp.longitude,
          altitude: 0,
          description: '',
        };
        onEventClick(syntheticEvent);
      });
    }
  }

  /**
   * Render task turnpoints list
   */
  function renderTask(): void {
    if (!currentTask || currentTask.turnpoints.length === 0) {
      eventCountEl.textContent = 'No task loaded';
      taskListContainer.innerHTML = `
        <div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
          No task loaded
        </div>
      `;
      return;
    }

    const segmentDistances = getOptimizedSegmentDistances(currentTask);
    const totalDistance = segmentDistances.reduce((sum, d) => sum + d, 0);
    eventCountEl.textContent = `${currentTask.turnpoints.length} turnpoints · ${formatDistance(totalDistance).withUnit}`;

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

      const isSelected = selectedTurnpointIndex === i;
      const selectedClass = isSelected ? 'ring-2 ring-primary' : '';

      html += `
        <button class="turnpoint-item w-full text-left rounded-lg border border-border bg-muted/30 p-3 cursor-pointer hover:bg-muted/50 transition-colors ${selectedClass}" data-turnpoint-index="${i}">
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
        </button>
      `;
    }

    html += '</div>';
    taskListContainer.innerHTML = html;

    // Add click handlers for turnpoint items
    taskListContainer.querySelectorAll('.turnpoint-item').forEach(item => {
      item.addEventListener('click', () => {
        const indexStr = item.getAttribute('data-turnpoint-index');
        if (indexStr !== null) {
          const index = parseInt(indexStr, 10);
          selectedTurnpointIndex = index;

          // Update selection visual
          taskListContainer.querySelectorAll('.turnpoint-item').forEach(el => {
            el.classList.remove('ring-2', 'ring-primary');
          });
          item.classList.add('ring-2', 'ring-primary');

          // Call the callback to pan the map
          options.onTurnpointClick?.(index);
        }
      });
    });
  }

  /**
   * Find the nearest segment-based event to a fix index from a list of candidates.
   * Checks containment first, then finds the closest segment start/end.
   */
  function findNearestSegmentEvent(fixIndex: number, candidates: { segment: { startIndex: number; endIndex: number }; sourceEvent: FlightEvent }[]): FlightEvent | null {
    if (candidates.length === 0) return null;

    // First check if fixIndex falls inside any segment
    for (const c of candidates) {
      if (fixIndex >= c.segment.startIndex && fixIndex <= c.segment.endIndex) {
        return c.sourceEvent;
      }
    }

    // Otherwise find the segment whose start or end is closest
    let best: FlightEvent | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const distToStart = Math.abs(fixIndex - c.segment.startIndex);
      const distToEnd = Math.abs(fixIndex - c.segment.endIndex);
      const dist = Math.min(distToStart, distToEnd);
      if (dist < bestDist) {
        bestDist = dist;
        best = c.sourceEvent;
      }
    }
    return best;
  }

  /**
   * Select the nearest event for the current tab at the given fix index.
   * Stays on the current tab rather than switching.
   */
  function selectNearestForCurrentTab(fixIndex: number): void {
    let matchingEvent: FlightEvent | null = null;

    if (currentTab === 'glides') {
      const glides = extractGlides();
      matchingEvent = findNearestSegmentEvent(fixIndex, glides);
    } else if (currentTab === 'climbs') {
      const climbs = extractClimbs();
      matchingEvent = findNearestSegmentEvent(fixIndex, climbs);
    } else if (currentTab === 'sinks') {
      const sinks = extractSinks();
      matchingEvent = findNearestSegmentEvent(fixIndex, sinks);
    } else if (currentTab === 'events') {
      // For the events tab, find the nearest event by fixIndex or segment
      let bestDist = Infinity;
      for (const event of filteredEvents) {
        if (event.segment) {
          if (fixIndex >= event.segment.startIndex && fixIndex <= event.segment.endIndex) {
            matchingEvent = event;
            break;
          }
          const dist = Math.min(
            Math.abs(fixIndex - event.segment.startIndex),
            Math.abs(fixIndex - event.segment.endIndex)
          );
          if (dist < bestDist) {
            bestDist = dist;
            matchingEvent = event;
          }
        } else {
          const details = event.details as { fixIndex?: number } | undefined;
          if (details?.fixIndex !== undefined) {
            const dist = Math.abs(details.fixIndex - fixIndex);
            if (dist < bestDist) {
              bestDist = dist;
              matchingEvent = event;
            }
          }
        }
      }
    }

    if (matchingEvent) {
      selectedSegment = matchingEvent.segment || null;
      updateSparklineMarker(fixIndex);
      renderTrack(); // re-render to update selection highlight
      onEventClick(matchingEvent);
    }
  }

  /**
   * Internal implementation of selectByFixIndex, used by the public method
   */
  function selectByFixIndexInternal(fixIndex: number, selectOptions?: { skipPan?: boolean }): void {
    if (allEvents.length === 0) return;

    let matchingEvent: FlightEvent | null = null;
    let eventType: 'glide' | 'climb' | 'sink' | 'event' = 'event';

    // Check thermals first — they are shorter, more specific segments and
    // more likely what the user intended to click on.
    for (const event of allEvents) {
      if (event.type === 'thermal_entry' && event.segment) {
        if (fixIndex >= event.segment.startIndex && fixIndex <= event.segment.endIndex) {
          matchingEvent = event;
          eventType = 'climb';
          break;
        }
      }
    }

    // Check glides
    if (!matchingEvent) {
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
      updateSparklineMarker(fixIndex);

      if (eventType === 'glide') {
        switchTabInternal('glides');
      } else if (eventType === 'climb') {
        switchTabInternal('climbs');
      } else if (eventType === 'sink') {
        switchTabInternal('sinks');
      } else {
        switchTabInternal('events');
      }

      options.onEventClick(matchingEvent, selectOptions?.skipPan ? { skipPan: true } : undefined);
    }
  }

  return {
    setEvents(events: FlightEvent[]) {
      allEvents = events;
      updateFilteredEvents();
      if (currentTab !== 'task') {
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
      if (currentTab === 'score') {
        renderScore();
      }
    },

    setScore(result: TurnpointSequenceResult | null) {
      currentScore = result;
      if (currentTab === 'score') {
        renderScore();
      }
    },

    setAltitudes(altitudes: number[], timestamps?: Date[]) {
      applySparklineBackground(altitudes, timestamps);
    },

    clearSelection() {
      selectedSegment = null;
      updateSparklineMarker(null);
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
      switchTabInternal(tab);
    },

    getCurrentTab(): PanelTabType {
      return currentTab;
    },

    selectByFixIndex(fixIndex: number, selectOptions?: { skipPan?: boolean }) {
      selectByFixIndexInternal(fixIndex, selectOptions);
    },

    selectTurnpoint(turnpointIndex: number) {
      if (!currentTask || turnpointIndex < 0 || turnpointIndex >= currentTask.turnpoints.length) {
        return;
      }

      selectedTurnpointIndex = turnpointIndex;

      // Switch to task tab if not already there
      if (currentTab !== 'task') {
        switchTabInternal('task');
      } else {
        // Re-render to show selection
        renderTask();
      }

      // Scroll the selected item into view
      const selectedItem = taskListContainer.querySelector(`[data-turnpoint-index="${turnpointIndex}"]`);
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },

    destroy() {
      panel.remove();
    },
  };
}
