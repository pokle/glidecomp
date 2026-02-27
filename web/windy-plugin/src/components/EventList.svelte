<!--
    Flight events timeline — shows key events with icons, times, and altitudes.
    Clicking an event pans the map to that location.
-->
{#if events.length > 0}
    <div class="event-list">
        <div class="event-list__header size-s mb-10">
            Flight Events ({events.length})
        </div>
        {#each displayEvents as event}
            <div
                class="event-row clickable size-xs mb-5"
                on:click={() => panTo(event)}
            >
                <span
                    class="event-row__dot"
                    style:background={getEventStyle(event.type).color}
                ></span>
                <span class="event-row__time">
                    {formatTime(event.time)}
                </span>
                <span class="event-row__desc">
                    {event.description}
                </span>
                <span class="event-row__alt">
                    {Math.round(event.altitude)}m
                </span>
            </div>
        {/each}
    </div>
{/if}

<script lang="ts">
    import { map } from '@windy/map';
    import { getEventStyle } from '@taskscore/engine';

    import type { FlightEvent } from '@taskscore/engine';

    export let events: FlightEvent[] = [];

    /** Key events worth listing in the sidebar. */
    const LIST_TYPES = new Set([
        'takeoff',
        'landing',
        'thermal_entry',
        'thermal_exit',
        'max_altitude',
        'min_altitude',
        'max_climb',
        'max_sink',
        'start_crossing',
        'goal_crossing',
        'turnpoint_reaching',
        'ess_reaching',
        'goal_reaching',
    ]);

    $: displayEvents = events.filter(e => LIST_TYPES.has(e.type));

    function formatTime(d: Date): string {
        return d.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    function panTo(event: FlightEvent) {
        map.setView({ lat: event.latitude, lng: event.longitude }, map.getZoom(), {
            animate: true,
        });
    }
</script>

<style lang="less">
    .event-list {
        max-height: 400px;
        overflow-y: auto;

        &__header {
            font-weight: 600;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
    }

    .event-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);

        &:hover {
            background: rgba(255, 255, 255, 0.05);
        }

        &__dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        &__time {
            opacity: 0.6;
            font-variant-numeric: tabular-nums;
            flex-shrink: 0;
        }

        &__desc {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        &__alt {
            opacity: 0.5;
            flex-shrink: 0;
            font-variant-numeric: tabular-nums;
        }
    }
</style>
