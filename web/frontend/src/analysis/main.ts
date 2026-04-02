// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * IGC Analysis Tool - Main Entry Point
 *
 * Wires together all components:
 * - File upload handling
 * - Task code fetching
 * - Map rendering
 * - Event detection and display
 */

import { parseIGC, parseXCTask, detectFlightEvents, calculateOptimizedTaskDistance, igcTaskToXCTask, resolveTurnpointSequence, scoreTask, maxBy, parseThresholdInput, formatThresholdForDisplay, DEFAULT_THRESHOLDS, type IGCFile, type IGCFix, type XCTask, type FlightEvent, type WaypointRecord, type DetectionThresholds, type PartialThresholds, type ThresholdDimension, type PilotFlight, type TaskScoreResult } from '@glidecomp/engine';
import { SAMPLE_COMPS } from '@glidecomp/samples';
import { getCurrentUser } from '../auth/client';
import { fetchTaskByCodeWithRaw } from './xctsk-fetch';
import { createMapProvider, type MapProvider, type MapProviderType, type LoadedTrack } from './map-provider';
import { createAnalysisPanel, AnalysisPanel, FlightInfo } from './analysis-panel';
import { loadCorryongWaypoints } from './waypoint-loader';
import { config, type UnitPreferences } from './config';
import { formatAltitude, formatDistance, onUnitsChanged } from './units-browser';
import { storage } from './storage';
import { StorageMenu } from './storage-menu';
import { fetchAirScoreTask, fetchAirScoreTrack } from './airscore-client';
import { downloadTask } from './task-editor';

// Import styles
import '../styles.css';

// Basecoat JS for interactive components
import "@pokle/basecoat/src/js/basecoat";
import "@pokle/basecoat/src/js/dropdown-menu";
import "@pokle/basecoat/src/js/command";
import "@pokle/basecoat/src/js/sidebar";

interface AppState {
  igcFile: IGCFile | null;
  task: XCTask | null;
  fixes: IGCFix[];
  events: FlightEvent[];
  /** All loaded tracks (for multi-track mode) */
  tracks: LoadedTrack[];
  /** Currently selected track index, or 'all' for multi-track view */
  selectedTrack: number | 'all';
  /** Competition score result (computed when 'all' is selected with a task) */
  compScore: TaskScoreResult | null;
}

const state: AppState = {
  igcFile: null,
  task: null,
  fixes: [],
  events: [],
  tracks: [],
  selectedTrack: 0,
  compScore: null,
};

let mapRenderer: MapProvider | null = null;
let analysisPanel: AnalysisPanel | null = null;
let storageMenu: StorageMenu | null = null;
let waypointDatabase: WaypointRecord[] = [];

// Feature toggle state, keyed by URL parameter name
const featureState: Record<string, boolean> = {};

/** Configuration for a single feature toggle in the command menu */
interface FeatureToggleConfig {
  menuId: string;
  statusId: string;
  urlParam: string;
  /** Whether the feature is on by default (affects URL param parsing) */
  defaultOn: boolean;
  /** Optional mapRenderer property that must be truthy; menu is hidden if unsupported */
  supportsProp?: keyof MapProvider;
  /** mapRenderer method name to call with the boolean state */
  providerMethod: keyof MapProvider;
  /** Called after each toggle with the new state */
  onToggle?: (enabled: boolean) => void;
}

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = "/u/me/";
    return;
  }
  if (!user.username) {
    window.location.href = "/onboarding.html";
    return;
  }

  const mapContainer = document.getElementById('map');
  const eventPanelContainer = document.getElementById('event-panel-container');
  const igcFileInput = document.getElementById('igc-file') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');
  const commandDialog = document.getElementById('command-dialog') as HTMLDialogElement | null;
  const importTaskDialog = document.getElementById('import-task-dialog') as HTMLDialogElement | null;
  const importTaskInput = document.getElementById('import-task-input') as HTMLInputElement | null;
  const importAirscoreDialog = document.getElementById('import-airscore-dialog') as HTMLDialogElement | null;
  const importAirscoreInput = document.getElementById('import-airscore-input') as HTMLInputElement | null;

  // Menu items
  const menuFeedback = document.getElementById('menu-feedback');
  const menuOpenIgc = document.getElementById('menu-open-igc');
  const menuImportTask = document.getElementById('menu-import-task');
  const menuImportAirscore = document.getElementById('menu-import-airscore');
  const menuDownloadTask = document.getElementById('menu-download-task');
  const showSpeedLabel = document.getElementById('show-speed-label');

  // Settings dialog
  const menuConfigureSettings = document.getElementById('menu-configure-settings');
  const menuCompetitionSettings = document.getElementById('menu-competition-settings');
  const competitionSettingsDialog = document.getElementById('competition-settings-dialog') as HTMLDialogElement | null;
  const competitionSettingsContent = document.getElementById('competition-settings-content');
  const menuClearSession = document.getElementById('menu-clear-session');
  const settingsDialog = document.getElementById('settings-dialog') as HTMLDialogElement | null;
  const settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
  const unitSpeedSelect = document.getElementById('unit-speed-select') as HTMLSelectElement | null;
  const unitAltitudeSelect = document.getElementById('unit-altitude-select') as HTMLSelectElement | null;
  const unitDistanceSelect = document.getElementById('unit-distance-select') as HTMLSelectElement | null;
  const unitClimbRateSelect = document.getElementById('unit-climbrate-select') as HTMLSelectElement | null;

  // Sidebar elements
  const sidebar = document.getElementById('waypoint-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  // Map provider switch menu
  const menuSwitchMap = document.getElementById('menu-switch-map');
  const mapProviderLabel = document.getElementById('map-provider-label');

  if (!mapContainer || !eventPanelContainer) {
    console.error('Required containers not found');
    return;
  }

  // Determine map provider: URL param > saved preference > default
  // Force leaflet if no MapBox token is configured
  const hasMapboxToken = !!import.meta.env.VITE_MAPBOX_TOKEN;
  let providerType: MapProviderType;
  if (!hasMapboxToken) {
    providerType = 'leaflet';
  } else {
    const mapParam = new URLSearchParams(window.location.search).get('m');
    const savedMapProvider = config.getPreferences().mapProvider;
    providerType =
      mapParam === 'l' ? 'leaflet' :
      mapParam === 'm' ? 'mapbox' :
      savedMapProvider ?? 'mapbox';
  }

  // Initialize map
  try {
    mapRenderer = await createMapProvider(mapContainer, providerType);
  } catch (err) {
    console.error('Failed to initialize map:', err);
    showStatus('Failed to initialize map', 'error');
    return;
  }

  // Update provider label in command menu to show the target provider
  // Hide the switch option entirely if no Mapbox token is available
  if (mapProviderLabel) {
    if (!hasMapboxToken) {
      menuSwitchMap?.remove();
    } else {
      const targetProvider = providerType === 'leaflet' ? 'MapBox' : 'Leaflet';
      mapProviderLabel.textContent = `Switch Map Provider to ${targetProvider}`;
    }
  }

  // Load waypoint database for enriching IGC tasks and task editor search
  try {
    waypointDatabase = await loadCorryongWaypoints();
    console.log(`Loaded ${waypointDatabase.length} waypoints`);
  } catch (err) {
    console.warn('Failed to load waypoint database:', err);
  }

  // Initialize storage and menu
  try {
    await storage.init();
    storageMenu = new StorageMenu({
      onTaskSelect: async (taskId) => {
        commandDialog?.close();
        updateUrlParam('task', null);
        updateUrlParam('storedTask', taskId);
        await loadStoredTask(taskId);
      },
      onTrackSelect: async (trackId) => {
        commandDialog?.close();
        updateUrlParam('track', null);
        updateUrlParam('storedTrack', trackId);
        await loadStoredTrack(trackId);
      },
    });
    storageMenu.init();
    await storageMenu.refresh();
  } catch (err) {
    console.warn('Failed to initialize storage:', err);
  }

  // Set up feature toggles from config (data-driven approach)
  const params = new URLSearchParams(window.location.search);

  const featureToggles: FeatureToggleConfig[] = [
    {
      menuId: 'menu-3d-track',
      statusId: '3d-track-status',
      urlParam: '3d',
      defaultOn: false,
      supportsProp: 'supports3D',
      providerMethod: 'set3DMode',
      onToggle: () => analysisPanel?.clearSelection(),
    },
    {
      menuId: 'menu-toggle-task',
      statusId: 'task-visibility-status',
      urlParam: 'task-visible',
      defaultOn: true,
      providerMethod: 'setTaskVisibility',
    },
    {
      menuId: 'menu-toggle-track',
      statusId: 'track-visibility-status',
      urlParam: 'track-visible',
      defaultOn: true,
      providerMethod: 'setTrackVisibility',
      onToggle: (enabled) => { if (!enabled) analysisPanel?.clearSelection(); },
    },
    {
      menuId: 'menu-show-speed',
      statusId: 'show-speed-status',
      urlParam: 'speed',
      defaultOn: false,
      providerMethod: 'setSpeedOverlay',
      onToggle: (enabled) => {
        if (showSpeedLabel) {
          showSpeedLabel.textContent = enabled ? 'Hide track metrics' : 'Show track metrics';
        }
        // Clear glide segment selection when enabling speed overlay
        if (enabled) {
          analysisPanel?.clearSelection();
        }
      },
    },
  ];

  for (const toggle of featureToggles) {
    const menuEl = document.getElementById(toggle.menuId);
    const statusEl = document.getElementById(toggle.statusId);

    // If the feature requires provider support and it's missing, hide the menu item
    if (toggle.supportsProp && !mapRenderer[toggle.supportsProp]) {
      if (menuEl) menuEl.style.display = 'none';
      continue;
    }

    if (!menuEl) continue;

    // Read initial state from URL params
    const paramValue = params.get(toggle.urlParam);
    const enabled = toggle.defaultOn
      ? paramValue !== '0'   // on-by-default: only '0' disables
      : paramValue === '1';  // off-by-default: only '1' enables
    featureState[toggle.urlParam] = enabled;
    updateFeatureStatus(statusEl, enabled);

    // Apply initial state to provider
    const method = mapRenderer[toggle.providerMethod];
    if (typeof method === 'function') {
      (method as (v: boolean) => void).call(mapRenderer, enabled);
    }

    // Apply initial side-effects (e.g. speed label text)
    if (enabled) {
      toggle.onToggle?.(enabled);
    }

    // Set up click handler
    menuEl.addEventListener('click', () => {
      const newState = !featureState[toggle.urlParam];
      featureState[toggle.urlParam] = newState;
      updateFeatureStatus(statusEl, newState);

      const providerFn = mapRenderer?.[toggle.providerMethod];
      if (typeof providerFn === 'function') {
        (providerFn as (v: boolean) => void).call(mapRenderer, newState);
        // For on-by-default features, remove param when on (default); set '0' when off
        // For off-by-default features, set '1' when on; remove param when off (default)
        const urlValue = toggle.defaultOn
          ? (newState ? null : '0')
          : (newState ? '1' : null);
        updateUrlParam(toggle.urlParam, urlValue);
      }

      toggle.onToggle?.(newState);
      commandDialog?.close();
    });
  }

  // Annotation mode toggle
  const annotateStatusEl = document.getElementById('annotate-status');

  function toggleAnnotation() {
    const layer = mapRenderer?.getAnnotationLayer?.();
    if (!layer) return;
    const newState = !layer.isEnabled();
    layer.setEnabled(newState);
    if (annotateStatusEl) {
      annotateStatusEl.textContent = newState ? '(on) D' : '(off) D';
    }
  }

  // Sync menu status when annotation is toggled via the map button
  mapRenderer?.getAnnotationLayer?.()?.onToggle((on) => {
    if (annotateStatusEl) {
      annotateStatusEl.textContent = on ? '(on) D' : '(off) D';
    }
  });

  document.getElementById('menu-annotate')?.addEventListener('click', () => {
    toggleAnnotation();
    commandDialog?.close();
  });

  // Text Shadow Tuner (debug tool for label styling)
  document.getElementById('menu-text-shadow-tuner')?.addEventListener('click', () => {
    commandDialog?.close();
    // Remove existing tuner if re-opened
    document.getElementById('ts-tuner-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'ts-tuner-panel';
    panel.innerHTML = `
      <div style="position:fixed;top:10px;right:10px;z-index:99999;background:#1e1e1e;color:#eee;padding:12px;border-radius:8px;font-family:monospace;font-size:13px;min-width:260px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:bold;">text-shadow tuner</span>
          <button id="ts-close" style="background:none;border:none;color:#eee;cursor:pointer;font-size:16px;" title="Close">\u00d7</button>
        </div>
        <label>blur <input id="ts-blur" type="range" min="0" max="10" step="0.5" value="0" style="width:120px;vertical-align:middle;"></label> <span id="ts-blur-v">0</span>px<br>
        <label>spread <input id="ts-spread" type="range" min="0" max="4" step="0.5" value="1" style="width:120px;vertical-align:middle;"></label> <span id="ts-spread-v">1</span>px<br>
        <label>color <input id="ts-color" type="color" value="#ffffff" style="vertical-align:middle;"></label><br>
        <label>opacity <input id="ts-opacity" type="range" min="0" max="1" step="0.05" value="1" style="width:120px;vertical-align:middle;"></label> <span id="ts-opacity-v">1</span><br>
        <div style="margin-top:8px;display:flex;gap:4px;">
          <button id="ts-preset-outline" style="padding:2px 6px;cursor:pointer;">outline</button>
          <button id="ts-preset-glow" style="padding:2px 6px;cursor:pointer;">glow</button>
          <button id="ts-preset-heavy" style="padding:2px 6px;cursor:pointer;">heavy</button>
          <button id="ts-preset-none" style="padding:2px 6px;cursor:pointer;">none</button>
        </div>
        <textarea id="ts-output" readonly style="margin-top:8px;padding:4px;background:#333;color:#eee;border:none;border-radius:4px;font-size:11px;font-family:monospace;width:240px;height:48px;resize:none;overflow:auto;word-wrap:break-word;"></textarea>
      </div>`;
    document.body.appendChild(panel);

    const inputs = {
      blur: panel.querySelector('#ts-blur') as HTMLInputElement,
      spread: panel.querySelector('#ts-spread') as HTMLInputElement,
      color: panel.querySelector('#ts-color') as HTMLInputElement,
      opacity: panel.querySelector('#ts-opacity') as HTMLInputElement,
    };
    const displays = {
      blur: panel.querySelector('#ts-blur-v') as HTMLElement,
      spread: panel.querySelector('#ts-spread-v') as HTMLElement,
      opacity: panel.querySelector('#ts-opacity-v') as HTMLElement,
      output: panel.querySelector('#ts-output') as HTMLTextAreaElement,
    };

    function applyShadow(shadow: string): void {
      document.querySelectorAll<HTMLElement>('[data-glide-label]').forEach(el => el.style.textShadow = shadow);
      document.querySelectorAll<HTMLElement>('[data-glide-chevron] span').forEach(el => el.style.textShadow = shadow);
      displays.output.value = `text-shadow: ${shadow}`;
    }

    function apply(): void {
      const { blur, spread, color, opacity } = inputs;
      displays.blur.textContent = blur.value;
      displays.spread.textContent = spread.value;
      displays.opacity.textContent = opacity.value;
      const r = parseInt(color.value.slice(1, 3), 16);
      const g = parseInt(color.value.slice(3, 5), 16);
      const b = parseInt(color.value.slice(5, 7), 16);
      const c = `rgba(${r},${g},${b},${opacity.value})`;
      const s = parseFloat(spread.value);
      const bl = parseFloat(blur.value);
      const shadow = [
        `${-s}px ${-s}px ${bl}px ${c}`, `${s}px ${-s}px ${bl}px ${c}`,
        `${-s}px ${s}px ${bl}px ${c}`, `${s}px ${s}px ${bl}px ${c}`,
        `0 0 ${bl + 2}px ${c}`,
      ].join(', ');
      applyShadow(shadow);
    }

    function setPreset(blur: string, spread: string, opacity: string, color = '#ffffff'): void {
      inputs.blur.value = blur;
      inputs.spread.value = spread;
      inputs.opacity.value = opacity;
      inputs.color.value = color;
      apply();
    }

    for (const input of Object.values(inputs)) {
      input.addEventListener('input', apply);
    }

    panel.querySelector('#ts-close')!.addEventListener('click', () => panel.remove());
    panel.querySelector('#ts-preset-outline')!.addEventListener('click', () => setPreset('0', '1', '1'));
    panel.querySelector('#ts-preset-glow')!.addEventListener('click', () => setPreset('4', '0', '0.9'));
    panel.querySelector('#ts-preset-heavy')!.addEventListener('click', () => setPreset('2', '2', '1'));
    panel.querySelector('#ts-preset-none')!.addEventListener('click', () => applyShadow('none'));

    apply();
  });

  // Switch Map Provider handler
  menuSwitchMap?.addEventListener('click', () => {
    const newProvider: MapProviderType = providerType === 'mapbox' ? 'leaflet' : 'mapbox';
    config.setPreferences({ mapProvider: newProvider });

    // Update URL param and reload (provider switch requires full page reload)
    const params = new URLSearchParams(window.location.search);
    params.set('m', newProvider === 'leaflet' ? 'l' : 'm');
    window.location.search = params.toString();
  });

  // Settings dialog handlers
  const populateSettingsDialog = () => {
    // Populate unit selects
    const units = config.getUnits();
    if (unitSpeedSelect) unitSpeedSelect.value = units.speed;
    if (unitAltitudeSelect) unitAltitudeSelect.value = units.altitude;
    if (unitDistanceSelect) unitDistanceSelect.value = units.distance;
    if (unitClimbRateSelect) unitClimbRateSelect.value = units.climbRate;

    // Populate threshold inputs
    const thresholds = config.getThresholds();
    const inputs = settingsForm?.querySelectorAll<HTMLInputElement>('.threshold-input');
    inputs?.forEach(input => {
      const group = input.dataset.group as keyof DetectionThresholds;
      const key = input.dataset.key as string;
      const dimension = input.dataset.dimension as ThresholdDimension;
      if (group && key && dimension) {
        const valueSI = (thresholds[group] as unknown as Record<string, number>)[key];
        input.value = formatThresholdForDisplay(valueSI, dimension, units);
        // Clear any previous error state
        input.classList.remove('border-destructive');
        const errorEl = input.parentElement?.querySelector('.threshold-error');
        if (errorEl) errorEl.remove();
      }
    });
  };

  // Open settings dialog
  menuConfigureSettings?.addEventListener('click', () => {
    commandDialog?.close();
    populateSettingsDialog();
    settingsDialog?.showModal();
  });

  // Competition settings dialog
  function populateCompetitionSettings(): void {
    if (!competitionSettingsContent) return;
    const params = config.getGAPParameters();
    const nominalPct = config.getNominalDistancePct();
    const helpLink = (hash: string, text: string, heading = false) =>
      `<a href="/scoring.html#${hash}" target="_blank" rel="noopener noreferrer" class="text-sm ${heading ? 'font-medium' : 'text-muted-foreground'} hover:text-foreground inline-flex items-center gap-0.5">${text} <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></a>`;
    competitionSettingsContent.innerHTML = `
      <form id="competition-settings-form" class="space-y-4">
        <div class="space-y-3">
          ${helpLink('what-is-gap', 'Scoring Type', true)}
          <div class="flex gap-4">
            <label class="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" name="gap-scoring" value="HG" ${params.scoring === 'HG' ? 'checked' : ''} class="accent-primary">
              Hang Gliding
            </label>
            <label class="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" name="gap-scoring" value="PG" ${params.scoring === 'PG' ? 'checked' : ''} class="accent-primary">
              Paragliding
            </label>
          </div>
        </div>

        <div class="space-y-3">
          ${helpLink('task-validity', 'Nominal Parameters', true)}
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <label for="gap-nominal-distance-pct" class="text-sm text-muted-foreground">Distance (% of task)</label>
              <input type="number" id="gap-nominal-distance-pct" value="${nominalPct}" min="1" max="100" step="1" class="input w-full">
            </div>
            <div class="space-y-1">
              <label for="gap-nominal-time" class="text-sm text-muted-foreground">Time (s)</label>
              <input type="number" id="gap-nominal-time" value="${params.nominalTime}" min="0" step="1" class="input w-full">
            </div>
            <div class="space-y-1">
              <label for="gap-nominal-launch" class="text-sm text-muted-foreground">Launch (%)</label>
              <input type="number" id="gap-nominal-launch" value="${Math.round(params.nominalLaunch * 100)}" min="0" max="100" step="1" class="input w-full">
            </div>
            <div class="space-y-1">
              <label for="gap-nominal-goal" class="text-sm text-muted-foreground">Goal (%)</label>
              <input type="number" id="gap-nominal-goal" value="${Math.round(params.nominalGoal * 100)}" min="0" max="100" step="1" class="input w-full">
            </div>
            <div class="space-y-1">
              ${helpLink('distance-points', 'Min distance (m)')}
              <input type="number" id="gap-minimum-distance" value="${params.minimumDistance}" min="0" step="1" class="input w-full">
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <label class="text-sm font-medium">Point Categories</label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" id="gap-use-leading" ${params.useLeading ? 'checked' : ''} class="accent-primary">
            <a href="/scoring.html#leading-points" target="_blank" rel="noopener noreferrer" class="hover:text-foreground">Leading (departure) points</a>
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" id="gap-use-arrival" ${params.useArrival ? 'checked' : ''} class="accent-primary">
            <a href="/scoring.html#arrival-points" target="_blank" rel="noopener noreferrer" class="hover:text-foreground">Arrival points (HG only)</a>
          </label>
        </div>

        <div class="flex gap-2 pt-2">
          <button type="submit" class="btn btn-primary flex-1">Save</button>
          <button type="button" id="gap-reset-btn" class="btn btn-secondary">Reset to defaults</button>
        </div>

        <div class="pt-2 text-xs text-center">
          <a href="/scoring.html" target="_blank" rel="noopener noreferrer" class="text-muted-foreground hover:text-foreground transition-colors underline">How does GAP scoring work?</a>
        </div>
      </form>
    `;

    const form = competitionSettingsContent.querySelector('#competition-settings-form') as HTMLFormElement;
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const scoring = (form.querySelector('input[name="gap-scoring"]:checked') as HTMLInputElement)?.value as 'PG' | 'HG' || 'HG';
      const parseNum = (id: string, fallback: number) => {
        const v = parseFloat((form.querySelector(id) as HTMLInputElement).value);
        return Number.isNaN(v) ? fallback : v;
      };
      config.setNominalDistancePct(parseNum('#gap-nominal-distance-pct', 70));
      config.setGAPParameters({
        scoring,
        nominalTime: parseNum('#gap-nominal-time', 5400),
        nominalLaunch: parseNum('#gap-nominal-launch', 96) / 100,
        nominalGoal: parseNum('#gap-nominal-goal', 20) / 100,
        minimumDistance: parseNum('#gap-minimum-distance', 5000),
        useLeading: (form.querySelector('#gap-use-leading') as HTMLInputElement).checked,
        useArrival: (form.querySelector('#gap-use-arrival') as HTMLInputElement).checked,
      });
      competitionSettingsDialog?.close();
      onCompetitionSettingsChanged();
    });

    form?.querySelector('#gap-reset-btn')?.addEventListener('click', () => {
      config.resetGAPParameters();
      populateCompetitionSettings();
      onCompetitionSettingsChanged();
    });
  }

  function openCompetitionSettings(): void {
    commandDialog?.close();
    populateCompetitionSettings();
    competitionSettingsDialog?.showModal();
  }

  function onCompetitionSettingsChanged(): void {
    if (state.selectedTrack === 'all' && state.tracks.length > 1) {
      computeCompetitionScore();
      analysisPanel?.setCompetitionScore(state.compScore);
      const pilotScores = state.compScore?.pilotScores ?? [];
      mapRenderer?.setMultiTrack?.(state.tracks, pilotScores);
    }
  }

  menuCompetitionSettings?.addEventListener('click', () => openCompetitionSettings());

  // Clear current task and track (reset to initial state)
  menuClearSession?.addEventListener('click', () => {
    commandDialog?.close();

    // Clear state
    state.igcFile = null;
    state.task = null;
    state.fixes = [];
    state.events = [];
    state.tracks = [];
    state.selectedTrack = 0;
    state.compScore = null;
    updateDownloadTaskVisibility();

    // Clear map
    if (mapRenderer) {
      mapRenderer.clearTrack();
      mapRenderer.clearTask();
      mapRenderer.clearEvents();
      mapRenderer.clearMultiTrack?.();
    }

    // Reset speed overlay state (must call setSpeedOverlay to clear provider flag)
    featureState['speed'] = false;
    mapRenderer?.setSpeedOverlay?.(false);
    updateFeatureStatus(document.getElementById('show-speed-status'), false);
    if (showSpeedLabel) showSpeedLabel.textContent = 'Show track metrics';
    updateUrlParam('speed', null);

    // Clear analysis panel
    analysisPanel?.setMultiTrackMode(false);
    analysisPanel?.setEvents([]);
    analysisPanel?.setAltitudes([]);
    analysisPanel?.setFlightInfo({});
    analysisPanel?.setTask(null);
    analysisPanel?.setScore(null);
    analysisPanel?.setCompetitionScore(null);
  });

  // Handle threshold reset buttons
  settingsForm?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const resetBtn = target.closest('.threshold-reset-btn') as HTMLButtonElement | null;
    if (!resetBtn) return;
    e.preventDefault();
    e.stopPropagation();

    const group = resetBtn.dataset.group as keyof DetectionThresholds;
    if (!group) return;

    // Reset inputs in this group to defaults
    const units = config.getUnits();
    const defaults = DEFAULT_THRESHOLDS[group] as unknown as Record<string, number>;
    const inputs = settingsForm.querySelectorAll<HTMLInputElement>(`.threshold-input[data-group="${group}"]`);
    inputs.forEach(input => {
      const key = input.dataset.key as string;
      const dimension = input.dataset.dimension as ThresholdDimension;
      if (key && dimension && defaults[key] !== undefined) {
        input.value = formatThresholdForDisplay((defaults as Record<string, number>)[key], dimension, units);
        input.classList.remove('border-destructive');
        const errorEl = input.parentElement?.querySelector('.threshold-error');
        if (errorEl) errorEl.remove();
      }
    });
  });

  // Handle units reset button
  document.getElementById('units-reset-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (unitSpeedSelect) unitSpeedSelect.value = 'km/h';
    if (unitAltitudeSelect) unitAltitudeSelect.value = 'm';
    if (unitDistanceSelect) unitDistanceSelect.value = 'km';
    if (unitClimbRateSelect) unitClimbRateSelect.value = 'm/s';
  });

  // Select all on focus for threshold inputs
  settingsForm?.addEventListener('focus', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.classList?.contains('threshold-input')) {
      input.select();
    }
  }, true);

  // Handle settings form submission
  settingsForm?.addEventListener('submit', (e) => {
    e.preventDefault();

    // Parse and validate all threshold inputs
    const inputs = settingsForm?.querySelectorAll<HTMLInputElement>('.threshold-input');
    let hasError = false;
    const errorState = { firstError: null as HTMLElement | null };

    const thresholdUpdates: PartialThresholds = {};

    inputs?.forEach(input => {
      const group = input.dataset.group as keyof DetectionThresholds;
      const key = input.dataset.key as string;
      const dimension = input.dataset.dimension as ThresholdDimension;
      const min = parseFloat(input.dataset.min || '-Infinity');
      const max = parseFloat(input.dataset.max || 'Infinity');

      // Clear previous error
      input.classList.remove('border-destructive');
      const prevError = input.parentElement?.querySelector('.threshold-error');
      if (prevError) prevError.remove();

      if (!group || !key || !dimension) return;

      const parsed = parseThresholdInput(input.value, dimension);
      if (!parsed) {
        input.classList.add('border-destructive');
        const errorEl = document.createElement('p');
        errorEl.className = 'threshold-error text-xs text-destructive mt-0.5';
        errorEl.textContent = 'Invalid value';
        input.parentElement?.appendChild(errorEl);
        hasError = true;
        if (!errorState.firstError) errorState.firstError = input;
        return;
      }

      if (parsed.valueSI < min || parsed.valueSI > max) {
        input.classList.add('border-destructive');
        const errorEl = document.createElement('p');
        errorEl.className = 'threshold-error text-xs text-destructive mt-0.5';
        errorEl.textContent = `Must be between ${min} and ${max} (SI units)`;
        input.parentElement?.appendChild(errorEl);
        hasError = true;
        if (!errorState.firstError) errorState.firstError = input;
        return;
      }

      // Accumulate the update
      if (!thresholdUpdates[group]) {
        thresholdUpdates[group] = {};
      }
      (thresholdUpdates[group] as Record<string, number>)[key] = parsed.valueSI;
    });

    if (hasError) {
      errorState.firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Save units
    const newUnits: Partial<UnitPreferences> = {};
    if (unitSpeedSelect) newUnits.speed = unitSpeedSelect.value as UnitPreferences['speed'];
    if (unitAltitudeSelect) newUnits.altitude = unitAltitudeSelect.value as UnitPreferences['altitude'];
    if (unitDistanceSelect) newUnits.distance = unitDistanceSelect.value as UnitPreferences['distance'];
    if (unitClimbRateSelect) newUnits.climbRate = unitClimbRateSelect.value as UnitPreferences['climbRate'];

    // Check if thresholds differ from defaults — only store overrides
    const hasThresholdOverrides = Object.keys(thresholdUpdates).length > 0;

    config.setPreferences({
      units: newUnits as UnitPreferences,
      thresholds: hasThresholdOverrides ? thresholdUpdates : undefined,
    });
    settingsDialog?.close();
  });

  // Subscribe to unit changes for reactive updates
  onUnitsChanged(() => {
    redetectEvents();

    // Re-render map task labels with new units
    if (state.task) {
      mapRenderer?.setTask(state.task);
      analysisPanel?.setTask(state.task);
    }
  });

  // ── Sidebar width management ──
  // Width presets as fractions: 3/4, 1/2, 1/3, collapsed (0)
  const SIDEBAR_STORAGE_KEY = 'glidecomp-sidebar-width';
  const WIDTH_PRESETS = [1/2, 1/3, 0];
  const DEFAULT_SIDEBAR_WIDTH = 320; // px, default open width

  /** Open the sidebar to a given pixel width (0 = collapsed) */
  function openSidebar(width?: number): void {
    if (!sidebar) return;
    const w = width ?? (parseInt(localStorage.getItem(SIDEBAR_STORAGE_KEY) || '', 10) || DEFAULT_SIDEBAR_WIDTH);
    sidebar.style.width = w + 'px';
    sidebar.setAttribute('aria-hidden', 'false');
    if (window.innerWidth < 768) sidebarBackdrop?.classList.remove('hidden');
    syncHandlePosition();
    mapRenderer?.invalidateSize();
  }

  /** Collapse the sidebar to 0 width */
  function closeSidebar(): void {
    if (!sidebar) return;
    sidebar.style.width = '0px';
    sidebar.setAttribute('aria-hidden', 'true');
    sidebarBackdrop?.classList.add('hidden');
    syncHandlePosition();
    mapRenderer?.invalidateSize();
  }

  const resizeHandle = document.getElementById('sidebar-resize-handle');

  /** Keep the drag handle pinned to the sidebar's left edge */
  function syncHandlePosition(): void {
    if (!resizeHandle || !sidebar) return;
    resizeHandle.style.right = sidebar.style.width;
  }

  // Set up sidebar toggle for mobile
  if (sidebar && sidebarBackdrop) {
    document.addEventListener('basecoat:sidebar', ((e: CustomEvent) => {
      const detail = e.detail || {};
      if (detail.id && detail.id !== 'waypoint-sidebar') return;
      const isOpen = sidebar.getAttribute('aria-hidden') === 'false';
      if (detail.action === 'close' || (detail.action === undefined && isOpen)) {
        closeSidebar();
      } else {
        openSidebar();
      }
    }) as EventListener);
  }

  // Sidebar resize handle (drag + click-to-cycle)
  if (sidebar && resizeHandle) {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartWidth = 0;
    let wasClick = true;

    // Restore saved width on load (sidebar starts collapsed until opened)
    syncHandlePosition();

    resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      isDragging = true;
      wasClick = true;
      dragStartX = e.clientX;
      dragStartWidth = sidebar.offsetWidth;
      resizeHandle.setPointerCapture(e.pointerId);
      sidebar.style.transition = 'none';
      resizeHandle.style.transition = 'none';
      e.preventDefault();
    });

    resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = dragStartX - e.clientX;
      if (Math.abs(dx) > 3) wasClick = false;
      const newWidth = Math.max(0, Math.min(window.innerWidth * 0.9, dragStartWidth + dx));
      sidebar.style.width = newWidth + 'px';
      syncHandlePosition();
      mapRenderer?.invalidateSize();
    });

    resizeHandle.addEventListener('pointerup', () => {
      if (!isDragging) return;
      isDragging = false;
      sidebar.style.transition = '';
      resizeHandle.style.transition = '';

      if (wasClick) {
        // Cycle to the next smaller preset, wrapping back to largest
        const currentFraction = sidebar.offsetWidth / window.innerWidth;
        let nextPreset = WIDTH_PRESETS[0]; // default: wrap to largest
        for (let i = 0; i < WIDTH_PRESETS.length; i++) {
          if (currentFraction > WIDTH_PRESETS[i] + 0.03) {
            nextPreset = WIDTH_PRESETS[i];
            break;
          }
        }

        if (nextPreset === 0) {
          closeSidebar();
        } else {
          const newWidth = Math.round(window.innerWidth * nextPreset);
          sidebar.setAttribute('aria-hidden', 'false');
          sidebar.style.width = newWidth + 'px';
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(newWidth));
          syncHandlePosition();
        }
      } else {
        // Save dragged width
        const w = sidebar.offsetWidth;
        if (w < 50) {
          closeSidebar();
        } else {
          sidebar.setAttribute('aria-hidden', w > 0 ? 'false' : 'true');
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w));
        }
        syncHandlePosition();
      }
      mapRenderer?.invalidateSize();
    });
  }

  // Handle event click
  const handleEventClick = (event: FlightEvent, options?: { skipPan?: boolean }) => {
    if (mapRenderer) {
      mapRenderer.panToEvent(event, options);
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

  // Handle turnpoint click from panel - pan map to turnpoint center
  const handleTurnpointClick = (turnpointIndex: number) => {
    if (mapRenderer?.panToTurnpoint) {
      mapRenderer.panToTurnpoint(turnpointIndex);
    }

    // Close sidebar on mobile after selecting a turnpoint
    if (window.innerWidth < 768 && sidebar) {
      document.dispatchEvent(new CustomEvent('basecoat:sidebar', { detail: { action: 'close', id: 'waypoint-sidebar' } }));
    }
  };

  // Handle task edits from the task editor
  const handleTaskEdited = (task: XCTask) => {
    // Apply without re-setting on the panel (it already has the task)
    state.task = task;
    updateDownloadTaskVisibility();
    mapRenderer?.setTask(task);
    redetectEvents();
  };

  // Handle map click mode request from the task editor
  const handleMapClickModeRequest = (enabled: boolean) => {
    mapRenderer?.setInteractionMode?.(enabled ? 'add-waypoint' : 'view');
  };

  // Initialize analysis panel with hide/show callbacks for sidebar visibility
  analysisPanel = createAnalysisPanel({
    container: eventPanelContainer,
    onEventClick: handleEventClick,
    onTurnpointClick: handleTurnpointClick,
    onTaskEdited: handleTaskEdited,
    onMapClickModeRequest: handleMapClickModeRequest,
    onToggle: handlePanelToggle,
    onHide: () => closeSidebar(),
    onShow: () => openSidebar(),
    onLoadSampleFlight: () => {
      // Click the first sample flight button in the command menu
      const firstSampleBtn = document.getElementById('sample-tushar');
      if (firstSampleBtn) {
        firstSampleBtn.click();
      }
    },
    onPilotSelectionChanged: (selected: Set<string> | null) => {
      if (state.selectedTrack !== 'all' || state.tracks.length <= 1) return;
      const pilotScores = state.compScore?.pilotScores ?? [];
      if (selected === null) {
        // All selected — show all tracks, no event markers
        mapRenderer?.clearEvents();
        mapRenderer?.setMultiTrack?.(state.tracks, pilotScores);
      } else {
        const filteredTracks = state.tracks.filter(t => selected.has(t.pilotName));
        const filteredScores = pilotScores.filter(ps => selected.has(ps.pilotName));
        if (filteredTracks.length === 1) {
          // Single pilot selected — show their event markers
          mapRenderer?.setEvents(filteredTracks[0].events);
        } else {
          mapRenderer?.clearEvents();
        }
        mapRenderer?.setMultiTrack?.(filteredTracks, filteredScores);
      }
    },
    onOpenCompetitionSettings: () => openCompetitionSettings(),
  });

  // Pass waypoint database to the analysis panel for task editor search
  if (waypointDatabase.length > 0) {
    analysisPanel.setWaypointDatabase(waypointDatabase);
  }

  // Wire multi-track click handler
  mapRenderer.onMultiTrackClick?.((trackIndex: number, fixIndex: number) => {
    const track = state.tracks[trackIndex];
    if (!track) return;
    // Show HUD with pilot name for the clicked track
    mapRenderer?.showTrackPointHUDWithName?.(fixIndex, track.pilotName);
  });

  // Wire map click handler for task editor "click on map" mode
  mapRenderer.onMapClick?.((lat: number, lon: number) => {
    analysisPanel?.addTurnpoint(lat, lon);
  });

  // Wire native map control buttons
  mapRenderer.onMenuButtonClick?.(() => {
    commandDialog?.showModal();
  });
  mapRenderer.onPanelToggleClick?.(() => {
    analysisPanel?.show();
  });

  // Close button inside the sidebar panel
  document.getElementById('sidebar-close')?.addEventListener('click', () => {
    analysisPanel?.hide();
  });

  // First-visit tooltip on Analysis button
  if (!localStorage.getItem('glidecomp-seen-analysis-hint')) {
    // Find the panel toggle button container in the DOM (top-right control)
    const panelToggleContainer = document.querySelector('.mapboxgl-ctrl-top-right .mapboxgl-ctrl:first-child, .leaflet-top.leaflet-right .leaflet-bar:first-child');
    if (panelToggleContainer) {
      (panelToggleContainer as HTMLElement).style.position = 'relative';
      const tooltip = document.createElement('div');
      tooltip.className = 'analysis-tooltip';
      tooltip.textContent = 'View flight analysis here';
      panelToggleContainer.appendChild(tooltip);

      const dismissTooltip = () => {
        tooltip.remove();
        localStorage.setItem('glidecomp-seen-analysis-hint', '1');
        document.removeEventListener('click', dismissTooltip);
      };

      // Auto-dismiss after 4s or on any click
      setTimeout(dismissTooltip, 4000);
      document.addEventListener('click', dismissTooltip);
    }
  }

  // Register track click handler to select events when clicking on the track
  mapRenderer.onTrackClick?.((fixIndex: number) => {
    // Don't allow glide segment selection when speed overlay is active,
    // but still allow HUD stats
    if (!featureState['speed']) {
      // Debug: show clicked fix details before any segment lookup
      if (state.fixes.length > 0 && fixIndex >= 0 && fixIndex < state.fixes.length) {
        const fix = state.fixes[fixIndex];
        const time = fix.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const alt = formatAltitude(fix.gnssAltitude).withUnit;
        const inThermal = state.events.some(e => e.type === 'thermal_entry' && e.segment && fixIndex >= e.segment.startIndex && fixIndex <= e.segment.endIndex);
        const inGlide = state.events.some(e => e.type === 'glide_start' && e.segment && fixIndex >= e.segment.startIndex && fixIndex <= e.segment.endIndex);
        const segType = inThermal ? 'THERMAL' : inGlide ? 'GLIDE' : 'gap (no segment)';
        console.log(`[track-click] fix #${fixIndex}  ${time}  ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}  alt ${alt}  → ${segType}`);
      }

      analysisPanel?.selectByFixIndex(fixIndex, { skipPan: true });
    }

    // Show HUD on every track click (even with speed overlay active)
    if (mapRenderer?.showTrackPointHUD) {
      mapRenderer.showTrackPointHUD(fixIndex);
    }
  });

  // Register turnpoint click handler to open Task tab when clicking on a turnpoint on the map
  mapRenderer.onTurnpointClick?.((turnpointIndex: number) => {
    if (analysisPanel?.isHidden()) {
      analysisPanel.show();
    }
    analysisPanel?.selectTurnpoint(turnpointIndex);
  });

  // Feedback menu item opens mailto link
  menuFeedback?.addEventListener('click', () => {
    commandDialog?.close();
    window.location.href = 'mailto:tushar.pokle@gmail.com?subject=GlideComp%20Feedback%20for%20you';
  });

  // Download task menu item
  menuDownloadTask?.addEventListener('click', () => {
    commandDialog?.close();
    if (state.task) downloadTask(state.task);
  });

  function updateDownloadTaskVisibility(): void {
    menuDownloadTask?.classList.toggle('hidden', !state.task);
  }

  // Open IGC menu item triggers hidden file input
  menuOpenIgc?.addEventListener('click', () => {
    commandDialog?.close();
    igcFileInput?.click();
  });

  // File input handler (supports multiple file selection)
  igcFileInput?.addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;

    const igcFiles: File[] = [];
    for (const file of files) {
      const name = file.name.toLowerCase();
      if (name.endsWith('.xctsk')) {
        await loadXCTaskFile(file);
      } else if (name.endsWith('.igc')) {
        igcFiles.push(file);
      }
    }

    if (igcFiles.length > 0) {
      await loadMultipleIGCFiles(igcFiles);
    }
  });

  // Drag and drop handlers - listen on document to work regardless of map library
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone?.classList.add('drag-over');
  });

  document.addEventListener('dragleave', (e) => {
    // Only hide if leaving the document entirely (relatedTarget is null)
    if (e.relatedTarget === null) {
      dropZone?.classList.remove('drag-over');
    }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone?.classList.remove('drag-over');
    commandDialog?.close();

    const files = e.dataTransfer?.files;
    if (!files?.length) return;

    let recognized = false;
    const igcFiles: File[] = [];

    for (const file of files) {
      const name = file.name.toLowerCase();
      if (name.endsWith('.igc')) {
        recognized = true;
        igcFiles.push(file);
      } else if (name.endsWith('.xctsk')) {
        recognized = true;
        await loadXCTaskFile(file);
      }
    }

    if (igcFiles.length > 0) {
      await loadMultipleIGCFiles(igcFiles);
    }

    if (!recognized) {
      showStatus('Please drop IGC or XCTask files', 'warning');
    }
  });

  // Import task menu item -> opens import dialog
  menuImportTask?.addEventListener('click', () => {
    commandDialog?.close();
    if (importTaskInput) {
      importTaskInput.value = '';
    }
    importTaskDialog?.showModal();
    importTaskInput?.focus();
  });

  // Import task dialog input handler
  importTaskInput?.addEventListener('keydown', async (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter') {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const code = importTaskInput.value.trim();
      if (code) {
        importTaskDialog?.close();
        await loadTask(code);
      }
    } else if (keyEvent.key === 'Escape') {
      importTaskDialog?.close();
    }
  });

  // Import AirScore menu item -> opens AirScore dialog
  menuImportAirscore?.addEventListener('click', () => {
    commandDialog?.close();
    if (importAirscoreInput) {
      importAirscoreInput.value = '';
    }
    importAirscoreDialog?.showModal();
    importAirscoreInput?.focus();
  });

  // Import AirScore dialog input handler
  importAirscoreInput?.addEventListener('keydown', async (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter') {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const url = importAirscoreInput.value.trim();
      if (url) {
        importAirscoreDialog?.close();
        await loadAirScoreFromUrl(url);
      }
    } else if (keyEvent.key === 'Escape') {
      importAirscoreDialog?.close();
    }
  });

  // Keyboard shortcut for command menu (Cmd/Ctrl + K)
  document.addEventListener('keydown', (e) => {
    // Skip shortcuts when typing in inputs, textareas, or contenteditable
    const tag = (e.target as HTMLElement).tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable;

    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (commandDialog?.open) {
        commandDialog.close();
      } else {
        commandDialog?.showModal();
      }
      return;
    }
    // Cmd+, (or Ctrl+,) opens settings
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      populateSettingsDialog();
      settingsDialog?.showModal();
      return;
    }

    // --- Annotation keyboard shortcuts ---
    const layer = mapRenderer?.getAnnotationLayer?.();

    // Undo/redo only when annotation mode is active (avoid hijacking browser undo)
    if (layer?.isEnabled()) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        layer.redo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        layer.redo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        layer.undo();
        return;
      }
      // Ctrl+Shift+Delete = clear all annotations
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Delete') {
        e.preventDefault();
        layer.clearAll();
        return;
      }
    }

    // Don't fire single-key shortcuts when typing in inputs
    if (isInput) return;

    // 'D' toggles annotation mode (draw shortcut)
    if (e.key === 'd' || e.key === 'D') {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleAnnotation();
        return;
      }
    }

    if (layer?.isEnabled()) {
      // 'E' switches to eraser
      if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        layer.setMode('erase');
        return;
      }
      // Escape or 'V' exits annotation mode
      if (e.key === 'Escape' || e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        layer.setEnabled(false);
        if (annotateStatusEl) annotateStatusEl.textContent = '(off) D';
        return;
      }
    }
  });

  // --- State sync helpers ---

  function redetectEvents(): void {
    if (state.fixes.length > 0) {
      state.events = detectFlightEvents(state.fixes, state.task || undefined, config.getPartialThresholds());
      analysisPanel?.setEvents(state.events);
      mapRenderer?.setEvents(state.events);
    }
    updateFlightInfo();
    updateScore();
  }

  function applyTask(task: XCTask): void {
    state.task = task;
    updateDownloadTaskVisibility();
    mapRenderer?.setTask(task);
    analysisPanel?.setTask(task);
    redetectEvents();

    // Re-compute competition score if in all-tracks mode
    if (state.selectedTrack === 'all' && state.tracks.length > 1) {
      // Re-detect events for all tracks with the new task
      for (const track of state.tracks) {
        track.events = detectFlightEvents(track.fixes, task, config.getPartialThresholds());
      }
      computeCompetitionScore();
      analysisPanel?.setCompetitionScore(state.compScore);
      const pilotScores = state.compScore?.pilotScores ?? [];
      mapRenderer?.setMultiTrack?.(state.tracks, pilotScores);
    }
  }

  function applyTrack(igcFile: IGCFile): void {
    state.igcFile = igcFile;
    state.fixes = igcFile.fixes;

    // Also update multi-track state for single-track legacy flow
    const events = detectFlightEvents(igcFile.fixes, state.task || undefined, config.getPartialThresholds());
    state.tracks = [{
      pilotName: igcFile.header.pilot || 'Unknown',
      date: igcFile.header.date || null,
      filename: '',
      fixes: igcFile.fixes,
      events,
    }];
    state.selectedTrack = 0;
    state.compScore = null;

    // Clear any multi-track rendering
    mapRenderer?.clearMultiTrack?.();
    analysisPanel?.setMultiTrackMode(false);

    mapRenderer?.setTrack(igcFile.fixes);
    redetectEvents();
    analysisPanel?.setAltitudes(igcFile.fixes.map(f => f.gnssAltitude), igcFile.fixes.map(f => f.time));

    // Pulse the Analysis button to draw attention to the newly available data
    mapRenderer?.highlightPanelToggle?.();
  }

  /**
   * Load and parse an XCTask file
   */
  async function loadXCTaskFile(file: File): Promise<void> {

    try {
      const rawJson = await file.text();
      const task = parseXCTask(rawJson);
      applyTask(task);
    } catch (err) {
      console.error('Failed to parse task file:', err);
      showStatus(`Failed to parse task file: ${err}`, 'error');
    }
  }

  /**
   * Load and parse an IGC file
   */
  async function loadIGCFile(file: File): Promise<void> {


    try {
      const content = await file.text();
      await loadIGCContent(content, file.name, true);
    } catch (err) {
      console.error('Failed to parse IGC file:', err);
      showStatus(`Failed to parse IGC file: ${err}`, 'error');
    }
  }

  /**
   * Load IGC content (from file or storage)
   * @param shouldStore - whether to store in browser storage (true for new files, false for loading from storage)
   */
  async function loadIGCContent(content: string, filename: string, shouldStore: boolean): Promise<void> {
    const igcFile = parseIGC(content);

    // If IGC file has a declared task and no external task is loaded, use it
    if (igcFile.task && igcFile.task.start && !state.task) {
      const xcTask = igcTaskToXCTask(igcFile.task, { waypoints: waypointDatabase });
      applyTask(xcTask);
    }

    applyTrack(igcFile);

    // Store for future use
    if (shouldStore) {
      try {
        const id = await storage.storeTrack(filename, content, igcFile);
        await storageMenu?.refresh();
        updateUrlParam('storedTrack', id);
        updateUrlParam('track', null);
      } catch (err) {
        console.warn('Failed to store track:', err);
      }
    }

  }

  /**
   * Load multiple IGC files at once (replaces the full track set)
   */
  async function loadMultipleIGCFiles(files: File[], skipStorage = false): Promise<void> {
    const tracks: LoadedTrack[] = [];

    for (const file of files) {
      try {
        const content = await file.text();
        const igcFile = parseIGC(content);

        // Auto-detect task from first file that has one
        if (igcFile.task && igcFile.task.start && !state.task) {
          const xcTask = igcTaskToXCTask(igcFile.task, { waypoints: waypointDatabase });
          applyTask(xcTask);
        }

        const events = detectFlightEvents(igcFile.fixes, state.task || undefined, config.getPartialThresholds());

        tracks.push({
          pilotName: igcFile.header.pilot || file.name.replace(/\.igc$/i, ''),
          date: igcFile.header.date || null,
          filename: file.name,
          fixes: igcFile.fixes,
          events,
        });

        // Store in browser storage (skip for sample data)
        if (!skipStorage) {
          try {
            await storage.storeTrack(file.name, content, igcFile);
            await storageMenu?.refresh();
          } catch (err) {
            console.warn('Failed to store track:', err);
          }
        }
      } catch (err) {
        console.error(`Failed to parse ${file.name}:`, err);
        showStatus(`Failed to parse ${file.name}: ${err}`, 'error');
      }
    }

    if (tracks.length === 0) return;

    // Replace the full track set
    state.tracks = tracks;

    if (tracks.length === 1) {
      // Single track: use existing single-track flow
      state.selectedTrack = 0;
      selectSingleTrack(0);
    } else {
      // Multiple tracks: default to 'all' view
      state.selectedTrack = 'all';
      selectAllTracks();
    }
  }

  /**
   * Select a single track for detailed analysis
   */
  function selectSingleTrack(index: number): void {
    const track = state.tracks[index];
    if (!track) return;

    state.selectedTrack = index;

    // Set up single-track state
    state.fixes = track.fixes;
    state.events = track.events;

    // Clear multi-track rendering
    mapRenderer?.clearMultiTrack?.();

    // Render single track
    mapRenderer?.setTrack(track.fixes);
    mapRenderer?.setEvents(track.events);

    // Update analysis panel for single-track mode
    analysisPanel?.setMultiTrackMode(false);
    analysisPanel?.setEvents(track.events);
    analysisPanel?.setAltitudes(track.fixes.map(f => f.gnssAltitude), track.fixes.map(f => f.time));

    // Update flight info
    const info: FlightInfo = {};
    info.pilot = track.pilotName;
    if (track.date) info.date = track.date.toLocaleDateString();
    if (track.fixes.length > 0) {
      const duration = track.fixes[track.fixes.length - 1].time.getTime() - track.fixes[0].time.getTime();
      const hours = Math.floor(duration / 3600000);
      const mins = Math.floor((duration % 3600000) / 60000);
      info.duration = `${hours}h ${mins}m`;
      info.maxAlt = formatAltitude(maxBy(track.fixes, f => f.gnssAltitude)).withUnit;
    }
    if (state.task) {
      info.task = formatDistance(calculateOptimizedTaskDistance(state.task)).withUnit;
    }
    analysisPanel?.setFlightInfo(info);

    // Update single-track score
    if (state.task && track.fixes.length > 0) {
      analysisPanel?.setScore(resolveTurnpointSequence(state.task, track.fixes));
    } else {
      analysisPanel?.setScore(null);
    }
  }

  /**
   * Select all tracks for competition view
   */
  function selectAllTracks(): void {
    state.selectedTrack = 'all';

    // Compute competition score
    computeCompetitionScore();

    const pilotScores = state.compScore?.pilotScores ?? [];

    // Clear single-track event markers (don't make sense for multiple pilots)
    mapRenderer?.clearEvents();

    // Render all tracks on map with rank colors
    mapRenderer?.setMultiTrack?.(state.tracks, pilotScores);

    // Switch analysis panel to multi-track mode
    analysisPanel?.setMultiTrackMode(true);
    analysisPanel?.setCompetitionScore(state.compScore);

    // Update flight info for all tracks
    const info: FlightInfo = {};
    info.pilot = `${state.tracks.length} pilots`;
    if (state.task) {
      info.task = formatDistance(calculateOptimizedTaskDistance(state.task)).withUnit;
    }
    analysisPanel?.setFlightInfo(info);
  }

  /**
   * Compute competition scores for all loaded tracks
   */
  function computeCompetitionScore(): void {
    if (!state.task || state.tracks.length === 0) {
      state.compScore = null;
      return;
    }

    const pilots: PilotFlight[] = state.tracks.map(track => ({
      pilotName: track.pilotName,
      trackFile: track.filename,
      fixes: track.fixes,
    }));

    const gapParams = config.getGAPParameters();

    // Compute nominal distance from percentage of task distance
    const nominalPct = config.getNominalDistancePct();
    gapParams.nominalDistance = calculateOptimizedTaskDistance(state.task) * (nominalPct / 100);

    state.compScore = scoreTask(state.task, pilots, gapParams);
  }

  /**
   * Update the track selector dropdown on the map
   */
  /**
   * Load a stored track by ID
   */
  async function loadStoredTrack(id: string): Promise<void> {


    try {
      const stored = await storage.getTrack(id);
      if (!stored) {
        showStatus('Track not found in storage', 'error');
        return;
      }

      await storage.touchTrack(id);
      await loadIGCContent(stored.content, stored.filename, false);
      updateUrlParam('storedTrack', id);
      updateUrlParam('track', null);
    } catch (err) {
      console.error('Failed to load stored track:', err);
      showStatus(`Failed to load stored track: ${err}`, 'error');
    }
  }

  /**
   * Load task by code
   */
  async function loadTask(code: string): Promise<void> {


    try {
      // Check storage first
      const stored = await storage.getTask(code);
      let task: XCTask;

      if (stored) {
        task = stored.task;
        await storage.touchTask(code);
      } else {
        // Fetch from XContest
        const result = await fetchTaskByCodeWithRaw(code);
        task = result.task;

        // Store for future use
        try {
          await storage.storeTask(code, task, result.rawJson);
          await storageMenu?.refresh();
        } catch (err) {
          console.warn('Failed to store task:', err);
        }
      }

      applyTask(task);
      updateUrlParam('task', code);
      updateUrlParam('storedTask', null);
    } catch (err) {
      console.error('Failed to load task:', err);
      showStatus(`Failed to load task: ${err}`, 'error');
    }
  }

  /**
   * Load a stored task by ID (code)
   */
  async function loadStoredTask(code: string): Promise<void> {


    try {
      const stored = await storage.getTask(code);
      if (!stored) {
        showStatus('Task not found in storage', 'error');
        return;
      }

      await storage.touchTask(code);
      applyTask(stored.task);
      updateUrlParam('storedTask', code);
      updateUrlParam('task', null);
    } catch (err) {
      console.error('Failed to load stored task:', err);
      showStatus(`Failed to load stored task: ${err}`, 'error');
    }
  }

  /**
   * Parse AirScore URL and extract parameters
   * Supports URLs like: https://xc.highcloud.net/tracklog_map.html?trackid=43826&comPk=466&tasPk=2030
   */
  function parseAirScoreUrl(url: string): { trackId: string; comPk: number; tasPk: number } | null {
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;

      const trackId = params.get('trackid') || params.get('trackId');
      const comPk = params.get('comPk') || params.get('compk');
      const tasPk = params.get('tasPk') || params.get('taspk');

      if (!trackId || !comPk || !tasPk) {
        return null;
      }

      return {
        trackId,
        comPk: parseInt(comPk, 10),
        tasPk: parseInt(tasPk, 10),
      };
    } catch {
      return null;
    }
  }

  /**
   * Load task and track from AirScore URL
   */
  async function loadAirScoreFromUrl(url: string): Promise<void> {
    const params = parseAirScoreUrl(url);

    if (!params) {
      showStatus('Invalid AirScore URL. Expected format: https://xc.highcloud.net/tracklog_map.html?trackid=...&comPk=...&tasPk=...', 'error');
      return;
    }



    try {
      // Fetch task data first
      const taskData = await fetchAirScoreTask(params.comPk, params.tasPk);

      applyTask(taskData.task);

      // Now fetch the track
      const igcContent = await fetchAirScoreTrack(params.trackId, params.comPk, params.tasPk);
      const igcFile = parseIGC(igcContent);
      applyTrack(igcFile);

      // Build a descriptive filename
      const pilotName = taskData.pilots.find(p => p.trackId === params.trackId)?.name || 'Unknown';
      const taskName = taskData.competition.taskName || `Task ${params.tasPk}`;

    } catch (err) {
      console.error('Failed to load from AirScore:', err);
      showStatus(`Failed to load from AirScore: ${err}`, 'error');
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

        const maxAlt = maxBy(state.fixes, f => f.gnssAltitude);
        info.maxAlt = formatAltitude(maxAlt).withUnit;
      }
    }

    if (state.task) {
      const optimizedDistance = calculateOptimizedTaskDistance(state.task);
      info.task = formatDistance(optimizedDistance).withUnit;
    }

    analysisPanel?.setFlightInfo(info);
  }

  /**
   * Update score when task and track are both available
   */
  function updateScore(): void {
    if (state.task && state.fixes.length > 0) {
      analysisPanel?.setScore(resolveTurnpointSequence(state.task, state.fixes));
    } else {
      analysisPanel?.setScore(null);
    }
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
    'sample-tushar': '2025-01-05-Tushar-Corryong.igc',
    'sample-bells-apollo': '2026-03-08-Tushar-bells-to-apollo.IGC'
  };

  // Map sample track filenames to local task files (by competition date)
  const sampleTaskMap: Record<string, string> = {
  };

  async function loadLocalTask(taskFile: string): Promise<void> {
    try {
      const response = await fetch(`/data/tasks/${taskFile}.xctsk`);
      if (!response.ok) {
        throw new Error(`Failed to fetch task: ${response.status}`);
      }
      const rawJson = await response.text();
      const task = parseXCTask(rawJson);
      applyTask(task);
      updateUrlParam('task', taskFile);
      updateUrlParam('storedTask', null);
    } catch (err) {
      console.warn('Failed to load local task:', err);
      throw err;
    }
  }

  const loadSampleFile = (filename: string) => {
    const params = new URLSearchParams(window.location.search);
    const taskFile = sampleTaskMap[filename];
    if (taskFile) {
      params.set('task', taskFile);
      params.delete('storedTask');
    } else {
      params.delete('task');
      params.delete('storedTask');
    }
    params.set('track', filename);
    params.delete('storedTrack');
    window.location.search = params.toString();
  };

  Object.entries(sampleFiles).forEach(([id, filename]) => {
    document.getElementById(id)?.addEventListener('click', () => loadSampleFile(filename));
  });

  // Sample competition buttons
  document.getElementById('sample-comp-corryong')?.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.set('sampleComp', 'corryong-cup-2026-t1');
    params.delete('task');
    params.delete('track');
    params.delete('storedTask');
    params.delete('storedTrack');
    window.location.search = params.toString();
  });

  // Load sample competition if specified (exclusive — skips individual track/task params)
  const sampleCompId = params.get('sampleComp');
  if (sampleCompId) {
    await loadSampleComp(sampleCompId);
  } else {
    // Load from query params if present (e.g., ?task=buje&track=sample.igc)
    await loadFromQueryParams(loadTask, loadLocalTask, loadIGCFile, loadStoredTrack, loadStoredTask);
  }

  // Handle files received via Web Share Target (mobile share button)
  if (params.get('shared') === '1') {
    await loadSharedFiles();
    // Clean the URL so a refresh doesn't re-trigger
    params.delete('shared');
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }

  // If no task or track was loaded, open the command menu to guide users
  if (!params.get('task') && !params.get('track') && !params.get('storedTrack') && !params.get('storedTask') && !params.get('sampleComp') && params.get('shared') !== '1' && !state.igcFile && !state.task) {
    commandDialog?.showModal();
  }

  /**
   * Load a complete sample competition: task + all IGC tracks.
   */
  async function loadSampleComp(compId: string): Promise<void> {
    const comp = SAMPLE_COMPS[compId];
    if (!comp) {
      showStatus(`Unknown sample competition: ${compId}`, 'error');
      return;
    }

    const baseUrl = `/data/comps/${compId}`;
    showStatus(`Loading ${comp.name}...`, 'info');

    // 1. Load the task
    try {
      const taskResponse = await fetch(`${baseUrl}/${comp.taskFile}`);
      if (!taskResponse.ok) throw new Error(`HTTP ${taskResponse.status}`);
      const rawJson = await taskResponse.text();
      const task = parseXCTask(rawJson);
      applyTask(task);
    } catch (err) {
      showStatus(`Failed to load task for ${comp.name}: ${err}`, 'error');
      return;
    }

    // 2. Apply GAP parameters from the competition manifest
    config.setGAPParameters({
      scoring: comp.gapParams.scoring,
      nominalGoal: comp.gapParams.nominalGoal,
      nominalTime: comp.gapParams.nominalTime,
      minimumDistance: comp.gapParams.minimumDistance,
      useLeading: comp.gapParams.useLeading,
      useArrival: comp.gapParams.useArrival,
    });
    // Compute nominal distance percentage from the absolute value and task distance
    const taskDist = calculateOptimizedTaskDistance(state.task!);
    if (taskDist > 0) {
      config.setNominalDistancePct(Math.round((comp.gapParams.nominalDistance / taskDist) * 100));
    }

    // 3. Fetch all IGC files concurrently with progress
    let loaded = 0;
    const fetchResults = await Promise.allSettled(
      comp.igcFiles.map(async (filename) => {
        const response = await fetch(`${baseUrl}/${filename}`);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${filename}`);
        const content = await response.text();
        loaded++;
        showStatus(`Loading ${comp.name}: ${loaded}/${comp.igcFiles.length} tracks`, 'info');
        return new File([content], filename, { type: 'text/plain' });
      })
    );

    const files: File[] = [];
    for (const result of fetchResults) {
      if (result.status === 'fulfilled') {
        files.push(result.value);
      } else {
        console.warn('Failed to load track:', result.reason);
      }
    }

    if (files.length === 0) {
      showStatus('No tracks loaded', 'error');
      return;
    }

    // 4. Load all tracks (skip IndexedDB storage for sample data)
    await loadMultipleIGCFiles(files, true);
    showStatus(`Loaded ${comp.name}: ${files.length} tracks`, 'success');
  }

  /**
   * Load files that were shared via the Web Share Target API.
   * The service worker stores them in a dedicated cache bucket.
   */
  async function loadSharedFiles(): Promise<void> {
    const SHARE_CACHE = 'share-target-files';
    try {
      const cache = await caches.open(SHARE_CACHE);
      const keys = await cache.keys();

      for (const request of keys) {
        const response = await cache.match(request);
        if (!response) continue;

        const filename = response.headers.get('X-File-Name') || new URL(request.url).pathname.split('/').pop() || 'shared-file';
        const blob = await response.blob();
        const file = new File([blob], filename, { type: blob.type });

        const name = filename.toLowerCase();
        if (name.endsWith('.xctsk')) {
          await loadXCTaskFile(file);
        } else if (name.endsWith('.igc')) {
          await loadIGCFile(file);
        } else {
          showStatus(`Unsupported file type: ${filename}`, 'warning');
        }
      }

      // Clean up the cache
      await caches.delete(SHARE_CACHE);
    } catch (err) {
      console.error('Failed to load shared files:', err);
      showStatus(`Failed to load shared files: ${err}`, 'error');
    }
  }
}

/**
 * Parse URL query parameters and load task/track if specified
 */
async function loadFromQueryParams(
  loadTask: (code: string) => Promise<void>,
  loadLocalTask: (taskFile: string) => Promise<void>,
  loadIGCFile: (file: File) => Promise<void>,
  loadStoredTrack: (id: string) => Promise<void>,
  loadStoredTask: (code: string) => Promise<void>
): Promise<void> {
  const params = new URLSearchParams(window.location.search);

  const taskCode = params.get('task');
  const trackFile = params.get('track');
  const storedTrackId = params.get('storedTrack');
  const storedTaskCode = params.get('storedTask');

  // Load stored task from IndexedDB (e.g. from dashboard link)
  if (storedTaskCode) {
    await loadStoredTask(storedTaskCode);
  }
  // Load task by code - try local file first, then remote
  else if (taskCode) {
    try {
      await loadLocalTask(taskCode);
    } catch {
      await loadTask(taskCode);
    }
  }

  // Load stored track from IndexedDB (e.g. from dashboard link)
  if (storedTrackId) {
    await loadStoredTrack(storedTrackId);
  }
  // Load track from samples folder if specified
  else if (trackFile) {
    // Security: validate filename to prevent directory traversal
    const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+\.igc$/i;

    if (!safeFilenamePattern.test(trackFile) || trackFile.includes('..')) {
      console.error('Invalid track filename:', trackFile);
      return;
    }

    try {
      const response = await fetch(`/data/tracks/${trackFile}`);
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

// Register service worker (enables PWA install + Web Share Target)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
