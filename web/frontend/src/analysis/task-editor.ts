/**
 * Task Editor Component
 *
 * Provides an editable waypoint list for building and modifying XCTasks.
 * Features: inline editing, drag-and-drop reorder, add/delete waypoints.
 */

import type { XCTask, Turnpoint, TurnpointType, WaypointRecord } from '@glidecomp/engine';
import { getOptimizedSegmentDistances, toXctskJSON } from '@glidecomp/engine';
import { formatDistance, formatAltitude } from './units-browser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskEditorOptions {
  container: HTMLElement;
  onTaskChanged: (task: XCTask) => void;
  onTurnpointClick?: (turnpointIndex: number) => void;
  onMapClickModeRequest?: (enabled: boolean) => void;
}

export interface TaskEditor {
  setTask(task: XCTask | null): void;
  setWaypointDatabase(waypoints: WaypointRecord[]): void;
  addTurnpointFromMap(lat: number, lon: number): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Turnpoint type metadata
// ---------------------------------------------------------------------------

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Turnpoint' },
  { value: 'TAKEOFF', label: 'Takeoff' },
  { value: 'SSS', label: 'Start (SSS)' },
  { value: 'ESS', label: 'ESS' },
];

const TYPE_COLORS: Record<string, string> = {
  TAKEOFF: 'text-blue-600',
  SSS: 'text-green-600',
  ESS: 'text-yellow-600',
};
const DEFAULT_TYPE_COLOR = 'text-blue-600';

const TYPE_LABELS: Record<string, string> = {
  TAKEOFF: 'Takeoff',
  SSS: 'Start (SSS)',
  ESS: 'ESS',
};
const DEFAULT_TYPE_LABEL = 'Turnpoint';

// ---------------------------------------------------------------------------
// SVG Icons (inline, no external deps)
// ---------------------------------------------------------------------------

const ICON_GRIP = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="shrink-0 text-muted-foreground/50"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`;

const ICON_PLUS = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

const ICON_MAP_PIN = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;

const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

const ICON_X = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`;

const ICON_SEARCH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

const ICON_COORDS = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskEditor(options: TaskEditorOptions): TaskEditor {
  const { container, onTaskChanged, onTurnpointClick, onMapClickModeRequest } = options;

  let currentTask: XCTask | null = null;
  let waypointDatabase: WaypointRecord[] = [];
  let expandedIndex: number | null = null;
  let mapClickMode = false;
  let addMenuOpen = false;
  let searchOpen = false;
  let coordsInputOpen = false;
  let wpCounter = 0;

  // Drag state
  let dragIndex: number | null = null;
  let dragOverIndex: number | null = null;
  let dragStartY = 0;
  let dragThreshold = 8;
  let isDragging = false;

  // ---------------------------------------------------------------------------
  // Task mutation helpers
  // ---------------------------------------------------------------------------

  function ensureTask(): XCTask {
    if (!currentTask) {
      currentTask = {
        taskType: 'CLASSIC',
        version: 1,
        earthModel: 'WGS84',
        turnpoints: [],
      };
    }
    return currentTask;
  }

  function emitTaskChanged(): void {
    if (currentTask) {
      onTaskChanged(currentTask);
    }
  }

  function addWaypoint(lat: number, lon: number, name?: string, radius = 400, altitude?: number, type?: TurnpointType): void {
    const task = ensureTask();
    wpCounter++;
    const tp: Turnpoint = {
      type,
      radius,
      waypoint: {
        name: name || `WP ${wpCounter}`,
        lat,
        lon,
        altSmoothed: altitude,
      },
    };
    task.turnpoints.push(tp);
    expandedIndex = task.turnpoints.length - 1;
    render();
    emitTaskChanged();
  }

  function addWaypointFromDatabase(wp: WaypointRecord): void {
    addWaypoint(wp.latitude, wp.longitude, wp.description || wp.name, wp.radius || 400, wp.altitude);
  }

  function deleteTurnpoint(index: number): void {
    if (!currentTask) return;
    currentTask.turnpoints.splice(index, 1);
    if (expandedIndex === index) expandedIndex = null;
    else if (expandedIndex !== null && expandedIndex > index) expandedIndex--;
    render();
    emitTaskChanged();
  }

  function updateTurnpointField(index: number, field: string, value: string | number): void {
    if (!currentTask || !currentTask.turnpoints[index]) return;
    const tp = currentTask.turnpoints[index];

    switch (field) {
      case 'name':
        tp.waypoint.name = value as string;
        break;
      case 'type': {
        const newType = (value as string) || undefined;
        tp.type = newType as TurnpointType | undefined;
        if (newType === 'SSS' && !currentTask.sss) {
          currentTask.sss = { type: 'RACE', direction: 'EXIT' };
        }
        break;
      }
      case 'radius':
        tp.radius = Math.max(50, value as number);
        break;
      case 'altitude':
        tp.waypoint.altSmoothed = (value as number) || undefined;
        break;
    }

    render();
    emitTaskChanged();
  }

  function moveTurnpoint(fromIndex: number, toIndex: number): void {
    if (!currentTask) return;
    if (fromIndex === toIndex) return;
    const tps = currentTask.turnpoints;
    const [moved] = tps.splice(fromIndex, 1);
    tps.splice(toIndex, 0, moved);
    if (expandedIndex === fromIndex) expandedIndex = toIndex;
    else if (expandedIndex !== null) {
      if (fromIndex < expandedIndex && toIndex >= expandedIndex) expandedIndex--;
      else if (fromIndex > expandedIndex && toIndex <= expandedIndex) expandedIndex++;
    }
    render();
    emitTaskChanged();
  }

  function clearAll(): void {
    if (!currentTask) return;
    currentTask.turnpoints = [];
    expandedIndex = null;
    render();
    emitTaskChanged();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render(): void {
    container.innerHTML = '';

    // Zone A: Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'flex items-center gap-1 border-b border-border px-2 py-1.5';
    toolbar.innerHTML = `
      <button type="button" class="te-add-btn inline-flex items-center justify-center rounded p-1.5 hover:bg-muted transition-colors" title="Add waypoint">${ICON_PLUS}</button>
      <button type="button" class="te-map-pin-btn inline-flex items-center justify-center rounded p-1.5 hover:bg-muted transition-colors ${mapClickMode ? 'bg-primary text-primary-foreground' : ''}" title="Click map to add waypoint">${ICON_MAP_PIN}</button>
      <div class="flex-1"></div>
      <button type="button" class="te-download-btn inline-flex items-center justify-center rounded p-1.5 hover:bg-muted transition-colors text-muted-foreground disabled:opacity-30 disabled:pointer-events-none" title="Download task (.xctsk)">${ICON_DOWNLOAD}</button>
      <button type="button" class="te-clear-btn inline-flex items-center justify-center rounded p-1.5 hover:bg-muted transition-colors text-muted-foreground hover:text-destructive" title="Clear all waypoints">${ICON_TRASH}</button>
    `;
    container.appendChild(toolbar);

    // Wire toolbar buttons
    toolbar.querySelector('.te-add-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAddMenu();
    });
    toolbar.querySelector('.te-map-pin-btn')!.addEventListener('click', () => {
      toggleMapClickMode();
    });
    const downloadBtn = toolbar.querySelector('.te-download-btn') as HTMLButtonElement;
    if (!currentTask || currentTask.turnpoints.length === 0) {
      downloadBtn.disabled = true;
    } else {
      downloadBtn.addEventListener('click', () => {
        if (currentTask) downloadTask(currentTask);
      });
    }
    toolbar.querySelector('.te-clear-btn')!.addEventListener('click', (e) => {
      handleClearAll(e.currentTarget as HTMLElement);
    });

    // Add menu popover (conditionally shown)
    if (addMenuOpen) {
      renderAddMenu();
    }

    // Search inline (conditionally shown)
    if (searchOpen) {
      renderSearchField();
    }

    // Coordinates input (conditionally shown)
    if (coordsInputOpen) {
      renderCoordsInput();
    }

    // Zone B: Waypoint list
    const list = document.createElement('div');
    list.className = 'te-list flex-1 overflow-y-auto p-2 space-y-1.5';
    container.appendChild(list);

    const tps = currentTask?.turnpoints ?? [];

    if (tps.length === 0) {
      list.innerHTML = `
        <div class="flex flex-col items-center justify-center p-8 text-center text-muted-foreground gap-3">
          <div class="text-sm">Add waypoints to build a task</div>
          <button type="button" class="te-empty-add inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-sm hover:bg-muted transition-colors">
            ${ICON_PLUS} Add waypoint
          </button>
        </div>
      `;
      list.querySelector('.te-empty-add')?.addEventListener('click', () => toggleAddMenu());
    } else {
      const segmentDistances = getOptimizedSegmentDistances(currentTask!);

      for (let i = 0; i < tps.length; i++) {
        const card = renderWaypointCard(tps[i], i, tps.length, segmentDistances);
        list.appendChild(card);
      }
    }

    // Zone C: Stats footer
    if (tps.length > 0) {
      const segDists = getOptimizedSegmentDistances(currentTask!);
      const totalDist = segDists.reduce((s, d) => s + d, 0);
      const footer = document.createElement('div');
      footer.className = 'border-t border-border px-3 py-1.5 text-sm text-muted-foreground';
      footer.textContent = `${tps.length} turnpoint${tps.length !== 1 ? 's' : ''} \u00b7 ${formatDistance(totalDist).withUnit}`;
      container.appendChild(footer);
    }
  }

  function renderWaypointCard(tp: Turnpoint, index: number, total: number, segmentDistances: number[]): HTMLElement {
    const isExpanded = expandedIndex === index;
    const typeLabel = (tp.type && TYPE_LABELS[tp.type]) || DEFAULT_TYPE_LABEL;
    const typeClass = (tp.type && TYPE_COLORS[tp.type]) || DEFAULT_TYPE_COLOR;
    const radiusStr = formatDistance(tp.radius).withUnit;
    const altStr = tp.waypoint.altSmoothed ? formatAltitude(tp.waypoint.altSmoothed).withUnit : '\u2014';

    let distToHere = 0;
    for (let j = 0; j < index && j < segmentDistances.length; j++) {
      distToHere += segmentDistances[j];
    }
    const legDist = index > 0 && segmentDistances[index - 1] ? formatDistance(segmentDistances[index - 1]).withUnit : '\u2014';
    const cumDist = index > 0 ? formatDistance(distToHere).withUnit : 'Start';

    const card = document.createElement('div');
    card.className = `te-card rounded-lg border border-border bg-muted/30 transition-colors ${isExpanded ? 'ring-2 ring-primary' : 'hover:bg-muted/50'}`;
    card.dataset.index = String(index);

    // Collapsed header
    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 p-2 cursor-pointer';
    header.innerHTML = `
      <div class="te-drag-handle flex items-center justify-center w-6 h-11 cursor-grab shrink-0 touch-none" data-drag-handle>
        ${ICON_GRIP}
      </div>
      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium ${typeClass}">
        ${index + 1}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="font-medium text-sm truncate">${tp.waypoint.name}</span>
          <span class="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] ${typeClass}">${typeLabel}</span>
        </div>
        <div class="flex gap-3 text-xs text-muted-foreground mt-0.5">
          <span title="Radius">${radiusStr}</span>
          <span title="Altitude">${altStr}</span>
          <span title="Leg">${legDist}</span>
          <span title="Cumulative">${cumDist}</span>
        </div>
      </div>
      <button type="button" class="te-delete-btn shrink-0 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100" title="Delete waypoint">
        ${ICON_X}
      </button>
    `;

    // Show delete button on hover (CSS class approach)
    card.classList.add('group');
    const deleteBtn = header.querySelector('.te-delete-btn') as HTMLElement;
    // Always visible on touch devices, hover on desktop
    deleteBtn.classList.remove('opacity-0', 'group-hover:opacity-100');
    deleteBtn.classList.add('opacity-40', 'hover:opacity-100');

    card.appendChild(header);

    // Click handler for card body (not drag handle, not delete)
    header.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-drag-handle]') || target.closest('.te-delete-btn')) return;
      expandedIndex = isExpanded ? null : index;
      render();
      if (!isExpanded) onTurnpointClick?.(index);
    });

    // Delete handler
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTurnpoint(index);
    });

    // Drag handlers on the grip
    const dragHandle = header.querySelector('[data-drag-handle]') as HTMLElement;
    dragHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragIndex = index;
      dragStartY = e.clientY;
      isDragging = false;

      const onMove = (me: PointerEvent) => {
        if (!isDragging && Math.abs(me.clientY - dragStartY) > dragThreshold) {
          isDragging = true;
          card.style.opacity = '0.9';
          card.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
          card.style.zIndex = '50';
        }
        if (isDragging) {
          // Find which card we're over
          const cards = container.querySelectorAll('.te-card');
          for (const c of cards) {
            const rect = c.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (me.clientY < midY) {
              dragOverIndex = parseInt((c as HTMLElement).dataset.index || '0');
              break;
            }
            dragOverIndex = parseInt((c as HTMLElement).dataset.index || '0') + 1;
          }
          // Show insertion indicator
          cards.forEach((c, ci) => {
            (c as HTMLElement).style.borderTopColor = '';
            (c as HTMLElement).style.borderTopWidth = '';
            if (dragOverIndex !== null && ci === dragOverIndex && dragOverIndex !== dragIndex) {
              (c as HTMLElement).style.borderTopColor = 'hsl(var(--primary))';
              (c as HTMLElement).style.borderTopWidth = '2px';
            }
          });
        }
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (isDragging && dragIndex !== null && dragOverIndex !== null) {
          const to = dragOverIndex > dragIndex ? dragOverIndex - 1 : dragOverIndex;
          moveTurnpoint(dragIndex, to);
        }
        card.style.opacity = '';
        card.style.boxShadow = '';
        card.style.zIndex = '';
        dragIndex = null;
        dragOverIndex = null;
        isDragging = false;
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    // Expanded editing section
    if (isExpanded) {
      const expanded = document.createElement('div');
      expanded.className = 'border-t border-border p-2 space-y-2';
      expanded.innerHTML = `
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-[10px] text-muted-foreground uppercase tracking-wider">Name</label>
            <input type="text" class="te-field-name w-full rounded border border-border bg-background px-2 py-1 text-sm" value="${tp.waypoint.name}">
          </div>
          <div>
            <label class="text-[10px] text-muted-foreground uppercase tracking-wider">Type</label>
            <select class="te-field-type w-full rounded border border-border bg-background px-2 py-1 text-sm">
              ${TYPE_OPTIONS.map(o => `<option value="${o.value}" ${o.value === (tp.type || '') ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-[10px] text-muted-foreground uppercase tracking-wider">Radius (m)</label>
            <input type="number" class="te-field-radius w-full rounded border border-border bg-background px-2 py-1 text-sm" value="${tp.radius}" min="50" step="100">
          </div>
          <div>
            <label class="text-[10px] text-muted-foreground uppercase tracking-wider">Altitude (m)</label>
            <input type="number" class="te-field-altitude w-full rounded border border-border bg-background px-2 py-1 text-sm" value="${tp.waypoint.altSmoothed || ''}" placeholder="\u2014">
          </div>
        </div>
        <div class="text-[10px] text-muted-foreground">
          ${tp.waypoint.lat.toFixed(5)}, ${tp.waypoint.lon.toFixed(5)}
        </div>
      `;
      card.appendChild(expanded);

      // Wire field handlers
      const nameInput = expanded.querySelector('.te-field-name') as HTMLInputElement;
      const typeSelect = expanded.querySelector('.te-field-type') as unknown as HTMLSelectElement;
      const radiusInput = expanded.querySelector('.te-field-radius') as HTMLInputElement;
      const altInput = expanded.querySelector('.te-field-altitude') as HTMLInputElement;

      nameInput.addEventListener('change', () => updateTurnpointField(index, 'name', nameInput.value));
      typeSelect.addEventListener('change', () => updateTurnpointField(index, 'type', typeSelect.value));
      radiusInput.addEventListener('change', () => updateTurnpointField(index, 'radius', parseInt(radiusInput.value) || 400));
      altInput.addEventListener('change', () => updateTurnpointField(index, 'altitude', parseInt(altInput.value) || 0));

      // Prevent card click when interacting with inputs
      expanded.addEventListener('click', (e) => e.stopPropagation());
    }

    return card;
  }

  // ---------------------------------------------------------------------------
  // Add waypoint menu
  // ---------------------------------------------------------------------------

  function toggleAddMenu(): void {
    addMenuOpen = !addMenuOpen;
    if (addMenuOpen) {
      searchOpen = false;
      coordsInputOpen = false;
    }
    render();
  }

  function renderAddMenu(): void {
    const menu = document.createElement('div');
    menu.className = 'border-b border-border bg-muted/30 p-2 space-y-1';

    const items = [
      { icon: ICON_SEARCH, label: 'Search database', action: 'search' },
      { icon: ICON_COORDS, label: 'Paste coordinates', action: 'coords' },
      { icon: ICON_MAP_PIN, label: 'Click on map', action: 'map' },
    ];

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm hover:bg-muted transition-colors text-left';
      btn.innerHTML = `${item.icon}<span>${item.label}</span>`;
      btn.addEventListener('click', () => {
        addMenuOpen = false;
        if (item.action === 'search') {
          searchOpen = true;
          coordsInputOpen = false;
          render();
          // Focus search input after render
          setTimeout(() => container.querySelector<HTMLInputElement>('.te-search-input')?.focus(), 0);
        } else if (item.action === 'coords') {
          coordsInputOpen = true;
          searchOpen = false;
          render();
          setTimeout(() => container.querySelector<HTMLInputElement>('.te-coords-input')?.focus(), 0);
        } else if (item.action === 'map') {
          toggleMapClickMode();
          render();
        }
      });
      menu.appendChild(btn);
    }

    // Insert after toolbar
    container.insertBefore(menu, container.children[1]);
  }

  // ---------------------------------------------------------------------------
  // Waypoint search
  // ---------------------------------------------------------------------------

  function renderSearchField(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'border-b border-border bg-muted/20 p-2';
    wrapper.innerHTML = `
      <div class="relative">
        <input type="text" class="te-search-input w-full rounded border border-border bg-background pl-7 pr-7 py-1.5 text-sm" placeholder="Search waypoints..." autocomplete="off">
        <div class="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">${ICON_SEARCH}</div>
        <button type="button" class="te-search-close absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground">${ICON_X}</button>
      </div>
      <div class="te-search-results mt-1 max-h-48 overflow-y-auto scrollbar"></div>
    `;

    // Insert after toolbar (and after add menu if present)
    const insertRef = container.querySelector('.te-list') || container.children[1];
    container.insertBefore(wrapper, insertRef);

    const input = wrapper.querySelector('.te-search-input') as HTMLInputElement;
    const resultsEl = wrapper.querySelector('.te-search-results') as HTMLElement;
    const closeBtn = wrapper.querySelector('.te-search-close') as HTMLElement;

    closeBtn.addEventListener('click', () => {
      searchOpen = false;
      render();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchOpen = false;
        render();
      }
    });

    input.addEventListener('input', () => {
      const query = input.value.toLowerCase().trim();
      if (query.length < 2) {
        resultsEl.innerHTML = '';
        return;
      }

      const matches = waypointDatabase.filter(wp =>
        wp.name.toLowerCase().includes(query) ||
        (wp.description && wp.description.toLowerCase().includes(query))
      ).slice(0, 20);

      if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="text-xs text-muted-foreground p-2">No matches</div>';
        return;
      }

      resultsEl.innerHTML = '';
      for (const wp of matches) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'flex items-center justify-between w-full rounded px-2 py-1 text-sm hover:bg-muted transition-colors text-left';
        item.innerHTML = `
          <div class="min-w-0">
            <div class="font-medium truncate">${wp.description || wp.name}</div>
            <div class="text-[10px] text-muted-foreground">${wp.name} \u00b7 ${wp.altitude ? formatAltitude(wp.altitude).withUnit : ''} \u00b7 r=${wp.radius || 400}m</div>
          </div>
        `;
        item.addEventListener('click', () => {
          addWaypointFromDatabase(wp);
          // Keep search open for adding multiple
          input.value = '';
          resultsEl.innerHTML = '';
          input.focus();
        });
        resultsEl.appendChild(item);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Coordinates input
  // ---------------------------------------------------------------------------

  function renderCoordsInput(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'border-b border-border bg-muted/20 p-2';
    wrapper.innerHTML = `
      <div class="relative">
        <input type="text" class="te-coords-input w-full rounded border border-border bg-background px-2 py-1.5 text-sm" placeholder="-36.185, 147.891" autocomplete="off">
        <button type="button" class="te-coords-close absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground">${ICON_X}</button>
      </div>
      <div class="text-[10px] text-muted-foreground mt-1">Enter lat, lon (e.g. from Google Maps)</div>
    `;

    const insertRef = container.querySelector('.te-list') || container.children[1];
    container.insertBefore(wrapper, insertRef);

    const input = wrapper.querySelector('.te-coords-input') as HTMLInputElement;
    const closeBtn = wrapper.querySelector('.te-coords-close') as HTMLElement;

    closeBtn.addEventListener('click', () => {
      coordsInputOpen = false;
      render();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        coordsInputOpen = false;
        render();
      }
      if (e.key === 'Enter') {
        const parts = input.value.split(',').map(s => parseFloat(s.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          addWaypoint(parts[0], parts[1]);
          input.value = '';
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Map click mode
  // ---------------------------------------------------------------------------

  function toggleMapClickMode(): void {
    mapClickMode = !mapClickMode;
    onMapClickModeRequest?.(mapClickMode);
    render();
  }

  // ---------------------------------------------------------------------------
  // Clear all with inline confirmation
  // ---------------------------------------------------------------------------

  function handleClearAll(btn: HTMLElement): void {
    if (btn.dataset.confirming === 'true') return;

    btn.dataset.confirming = 'true';
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="text-xs text-destructive font-medium">Clear?</span>
      <span class="te-confirm-yes text-xs text-destructive underline cursor-pointer ml-1">Yes</span>
      <span class="te-confirm-no text-xs text-muted-foreground underline cursor-pointer ml-1">No</span>`;
    btn.classList.add('px-2');

    const timer = setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('px-2');
      btn.dataset.confirming = 'false';
    }, 3000);

    btn.querySelector('.te-confirm-yes')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(timer);
      clearAll();
    });
    btn.querySelector('.te-confirm-no')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(timer);
      btn.innerHTML = original;
      btn.classList.remove('px-2');
      btn.dataset.confirming = 'false';
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    setTask(task: XCTask | null) {
      currentTask = task;
      expandedIndex = null;
      mapClickMode = false;
      searchOpen = false;
      coordsInputOpen = false;
      addMenuOpen = false;
      render();
    },

    setWaypointDatabase(waypoints: WaypointRecord[]) {
      waypointDatabase = waypoints;
    },

    addTurnpointFromMap(lat: number, lon: number) {
      mapClickMode = false;
      onMapClickModeRequest?.(false);
      addWaypoint(lat, lon);
    },

    destroy() {
      container.innerHTML = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Task download
// ---------------------------------------------------------------------------

function deriveTaskFilename(task: XCTask): string {
  const meaningful = task.turnpoints.filter(tp => tp.type !== 'TAKEOFF');
  if (meaningful.length === 0) return 'task.xctsk';

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const first = sanitize(meaningful[0].waypoint.name);
  const last = sanitize(meaningful[meaningful.length - 1].waypoint.name);

  if (first === last || meaningful.length === 1) return `${first}.xctsk`;
  return `${first}-to-${last}.xctsk`;
}

export function downloadTask(task: XCTask): void {
  const json = JSON.stringify(toXctskJSON(task), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = deriveTaskFilename(task);
  a.click();
  URL.revokeObjectURL(url);
}
