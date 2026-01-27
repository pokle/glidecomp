/**
 * Command menu integration for stored tasks and tracks.
 */

import { storage, type StoredTask, type StoredTrack } from './storage';

const MAX_MENU_ITEMS = 10;

// SVG icons
const GLOBE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
  <path d="M2 12h20"/>
</svg>`;

const PLANE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
</svg>`;

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create a menu item for a stored task
 */
function createTaskMenuItem(task: StoredTask): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.id = `stored-task-${task.id}`;
  item.dataset.keywords = `stored task ${task.name} ${task.id}`.toLowerCase();
  item.dataset.taskId = task.id;
  item.innerHTML = `
    ${GLOBE_ICON}
    <span>${escapeHtml(task.name)}</span>
    <span class="text-muted-foreground text-xs ml-auto">${escapeHtml(task.id)}</span>
  `;
  return item;
}

/**
 * Create a menu item for a stored track
 */
function createTrackMenuItem(track: StoredTrack): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  const shortId = track.id.slice(0, 8);
  item.id = `stored-track-${shortId}`;

  // Build keywords for search
  const keywords = ['stored', 'track', track.name, track.filename];
  if (track.summary.pilot) keywords.push(track.summary.pilot);
  if (track.summary.glider) keywords.push(track.summary.glider);
  if (track.summary.date) keywords.push(track.summary.date);
  item.dataset.keywords = keywords.join(' ').toLowerCase();
  item.dataset.trackId = track.id;

  item.innerHTML = `
    ${PLANE_ICON}
    <span>${escapeHtml(track.name)}</span>
    <span class="text-muted-foreground text-xs ml-auto">${escapeHtml(track.filename)}</span>
  `;
  return item;
}

export interface StorageMenuCallbacks {
  onTaskSelect: (taskId: string) => void;
  onTrackSelect: (trackId: string) => void;
}

/**
 * Initialize and manage stored items in the command menu.
 */
export class StorageMenu {
  private tasksGroup: HTMLElement | null = null;
  private tasksSeparator: HTMLElement | null = null;
  private tracksGroup: HTMLElement | null = null;
  private tracksSeparator: HTMLElement | null = null;
  private callbacks: StorageMenuCallbacks;

  constructor(callbacks: StorageMenuCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initialize the menu groups in the DOM.
   * Call this after the command menu HTML is loaded.
   */
  init(): void {
    this.tasksGroup = document.getElementById('stored-tasks-group');
    this.tasksSeparator = document.getElementById('stored-tasks-separator');
    this.tracksGroup = document.getElementById('stored-tracks-group');
    this.tracksSeparator = document.getElementById('stored-tracks-separator');

    // Add click handlers using event delegation
    this.tasksGroup?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('[role="menuitem"]');
      if (item instanceof HTMLElement && item.dataset.taskId) {
        this.callbacks.onTaskSelect(item.dataset.taskId);
      }
    });

    this.tracksGroup?.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('[role="menuitem"]');
      if (item instanceof HTMLElement && item.dataset.trackId) {
        this.callbacks.onTrackSelect(item.dataset.trackId);
      }
    });
  }

  /**
   * Refresh the stored items in the command menu.
   * Call this after storing new items or on page load.
   */
  async refresh(): Promise<void> {
    const [tasks, tracks] = await Promise.all([
      storage.listTasks(),
      storage.listTracks(),
    ]);

    this.updateTasksGroup(tasks.slice(0, MAX_MENU_ITEMS));
    this.updateTracksGroup(tracks.slice(0, MAX_MENU_ITEMS));
  }

  private updateTasksGroup(tasks: StoredTask[]): void {
    if (!this.tasksGroup || !this.tasksSeparator) return;

    // Clear existing items (keep heading)
    const heading = this.tasksGroup.querySelector('[role="heading"]');
    this.tasksGroup.innerHTML = '';
    if (heading) {
      this.tasksGroup.appendChild(heading);
    }

    // Add items
    for (const task of tasks) {
      this.tasksGroup.appendChild(createTaskMenuItem(task));
    }

    // Show/hide based on content
    const hasItems = tasks.length > 0;
    this.tasksGroup.classList.toggle('hidden', !hasItems);
    this.tasksSeparator.classList.toggle('hidden', !hasItems);
  }

  private updateTracksGroup(tracks: StoredTrack[]): void {
    if (!this.tracksGroup || !this.tracksSeparator) return;

    // Clear existing items (keep heading)
    const heading = this.tracksGroup.querySelector('[role="heading"]');
    this.tracksGroup.innerHTML = '';
    if (heading) {
      this.tracksGroup.appendChild(heading);
    }

    // Add items
    for (const track of tracks) {
      this.tracksGroup.appendChild(createTrackMenuItem(track));
    }

    // Show/hide based on content
    const hasItems = tracks.length > 0;
    this.tracksGroup.classList.toggle('hidden', !hasItems);
    this.tracksSeparator.classList.toggle('hidden', !hasItems);
  }
}
