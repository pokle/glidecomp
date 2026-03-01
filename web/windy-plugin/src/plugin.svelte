<!--
    TaskScore Windy Plugin — Main entry.

    Loads an IGC file, parses it with @taskscore/engine, renders the
    flight track and events on Windy's Leaflet map, and shows an event
    timeline in the right-hand panel.
-->
<div class="plugin__mobile-header">
    {title}
</div>
<section class="plugin__content">
    <div
        class="plugin__title plugin__title--chevron-back"
        on:click={() => bcast.emit('rqstOpen', 'menu')}
    >
        {title}
    </div>

    {#if !flight}
        <FileLoader on:load={handleFile} />
    {:else}
        <div class="flight-info mb-15">
            <div class="size-s mb-5" style="opacity:0.6">
                {flight.filename}
            </div>
            {#if flight.igc.header}
                <div class="size-xs" style="opacity:0.5">
                    {flight.igc.header.pilot || 'Unknown pilot'}
                    {#if flight.igc.header.gliderType}
                        &middot; {flight.igc.header.gliderType}
                    {/if}
                </div>
            {/if}
            <div class="mt-10">
                <span
                    class="button button--variant-orange size-xs"
                    on:click={clearFlight}
                >
                    Load different file
                </span>
            </div>
        </div>

        <hr class="mb-15" />

        <EventList events={flight.events} />
    {/if}
</section>

<script lang="ts">
    import bcast from '@windy/broadcast';
    import { map } from '@windy/map';
    import { onDestroy, onMount } from 'svelte';

    import { parseIGC, detectFlightEvents } from '@taskscore/engine';

    import type { IGCFile, FlightEvent } from '@taskscore/engine';

    import config from './pluginConfig';
    import FileLoader from './components/FileLoader.svelte';
    import EventList from './components/EventList.svelte';

    import { renderTrack, removeTrack } from './map/track-renderer';
    import { renderEventMarkers, removeEventMarkers } from './map/event-markers';

    const { title } = config;

    interface LoadedFlight {
        filename: string;
        igc: IGCFile;
        events: FlightEvent[];
        trackLines: L.Polyline[];
        eventMarkers: L.CircleMarker[];
    }

    const STORAGE_KEY = 'taskscore:igc';

    let flight: LoadedFlight | null = null;

    function loadIGC(filename: string, text: string, fitBounds: boolean) {
        clearMapLayers();

        const igc = parseIGC(text);
        if (!igc.fixes.length) return;

        const events = detectFlightEvents(igc);
        const trackLines = renderTrack(map, igc.fixes);
        const eventMarkers = renderEventMarkers(map, events);

        if (fitBounds) {
            const lats = igc.fixes.map(f => f.latitude);
            const lngs = igc.fixes.map(f => f.longitude);
            const bounds = new L.LatLngBounds(
                { lat: Math.min(...lats), lng: Math.min(...lngs) },
                { lat: Math.max(...lats), lng: Math.max(...lngs) },
            );
            map.fitBounds(bounds, { padding: [40, 40] });
        }

        flight = { filename, igc, events, trackLines, eventMarkers };
    }

    function handleFile(e: CustomEvent<{ filename: string; text: string }>) {
        const { filename, text } = e.detail;
        loadIGC(filename, text, true);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ filename, text }));
        } catch {
            // localStorage full or unavailable — continue without persistence
        }
    }

    function restoreFromStorage() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return;
            const { filename, text } = JSON.parse(saved);
            if (filename && text) loadIGC(filename, text, false);
        } catch {
            // corrupt or unavailable — ignore
        }
    }

    function clearMapLayers() {
        if (!flight) return;
        removeTrack(map, flight.trackLines);
        removeEventMarkers(map, flight.eventMarkers);
    }

    function clearFlight() {
        clearMapLayers();
        flight = null;
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }

    export const onopen = () => {
        if (!flight) restoreFromStorage();
    };

    onMount(() => {
        // Plugin mounted.
    });

    onDestroy(() => {
        clearMapLayers();
    });
</script>

<style lang="less">
    .flight-info {
        padding: 10px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 6px;
    }
</style>
