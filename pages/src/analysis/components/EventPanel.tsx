/**
 * Event Panel Component
 *
 * Displays flight events in a scrollable list.
 * Uses Radix UI components for switch and scroll area.
 */

import type { ReactNode } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { useRef, useState, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { type FlightEvent, type FlightEventType, getEventStyle } from '../event-detector';

// Icons
const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0a5.53 5.53 0 0 0-3.594 1.342c-.766.66-1.321 1.52-1.464 2.383C1.266 4.095 0 5.555 0 7.318 0 9.366 1.708 11 3.781 11H7.5V5.707L5.354 7.854a.5.5 0 1 1-.708-.708l3-3a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 5.707V11h4.188C14.502 11 16 9.57 16 7.773c0-1.636-1.242-2.969-2.834-3.194C12.923 1.999 10.69 0 8 0zm-.5 14.5V11h1v3.5a.5.5 0 0 1-1 0z"/>
  </svg>
);

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
function EventIcon({ type }: { type: FlightEventType }) {
  const icons: Partial<Record<FlightEventType, ReactNode>> = {
    takeoff: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M2.5 19h19v2h-19v-2zm19.57-9.36c-.21-.8-1.04-1.28-1.84-1.06L14.92 10l-6.9-6.43-1.93.51 4.14 7.17-4.97 1.33-1.97-1.54-1.45.39 1.82 3.16.77 1.33 1.6-.43 5.31-1.42 4.35-1.16L21 11.49c.81-.23 1.28-1.05 1.07-1.85z"/>
      </svg>
    ),
    landing: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M2.5 19h19v2h-19v-2zm17.16-5.84l-7.29 1.95-6.41-6.14-1.93.52 4.14 7.17-4.97 1.33-1.97-1.54-1.45.39 1.82 3.16.77 1.33 1.6-.43L9.4 19.4l7.29-1.95 3.49-.93c.81-.22 1.28-1.04 1.07-1.84-.22-.81-1.04-1.28-1.84-1.06l-.75.2z"/>
      </svg>
    ),
    thermal_entry: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
      </svg>
    ),
    thermal_exit: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/>
      </svg>
    ),
    glide_start: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/>
      </svg>
    ),
    glide_end: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 4l1.41 1.41L7.83 11H20v2H7.83l5.58 5.59L12 20l-8-8 8-8z"/>
      </svg>
    ),
    turnpoint_entry: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
    ),
    turnpoint_exit: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
    ),
    start_crossing: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
      </svg>
    ),
    goal_crossing: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
      </svg>
    ),
    max_altitude: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/>
      </svg>
    ),
    min_altitude: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/>
      </svg>
    ),
    max_climb: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/>
      </svg>
    ),
    max_sink: (
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 18l2.29-2.29-4.88-4.88-4 4L2 7.41 3.41 6l6 6 4-4 6.3 6.29L22 12v6z"/>
      </svg>
    ),
  };

  return icons[type] || (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="8"/>
    </svg>
  );
}

interface EventPanelProps {
  onFileSelect?: () => void;
}

export function EventPanel({ onFileSelect }: EventPanelProps) {
  const {
    events,
    flightInfo,
    filterVisibleEvents,
    setFilterVisibleEvents,
    getFilteredEvents,
    selectEvent,
    selectedEvent,
    loadTask,
  } = useAppContext();

  const [taskCode, setTaskCode] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { loadIGCFile } = useAppContext();

  const filteredEvents = getFilteredEvents();

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await loadIGCFile(file);
    }
  }, [loadIGCFile]);

  const handleFileButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleLoadTask = async () => {
    if (taskCode.trim()) {
      await loadTask(taskCode.trim());
    }
  };

  const handleTaskKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleLoadTask();
    }
  };

  const handleEventClick = (event: FlightEvent) => {
    selectEvent(event);
  };

  return (
    <div className="event-panel">
      {/* Controls */}
      <div className="drawer-controls">
        <button className="btn btn-sm" onClick={handleFileButtonClick}>
          <UploadIcon />
          Choose IGC
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".igc"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        <div className="task-input-group">
          <input
            type="text"
            className="input input-sm"
            placeholder="Task code"
            value={taskCode}
            onChange={(e) => setTaskCode(e.target.value)}
            onKeyDown={handleTaskKeyDown}
          />
          <button className="btn btn-primary btn-sm" onClick={handleLoadTask}>
            Load
          </button>
        </div>
      </div>

      {/* Header */}
      <div className="event-panel-header">
        <h2>Flight Events</h2>
      </div>

      {/* Flight Info */}
      <div className="event-panel-info">
        {Object.keys(flightInfo).length > 0 ? (
          <>
            {flightInfo.pilot && <strong>{flightInfo.pilot}</strong>}
            {flightInfo.date && <><span className="separator">|</span>{flightInfo.date}</>}
            {flightInfo.glider && <><span className="separator">|</span>{flightInfo.glider}</>}
            {flightInfo.duration && <><span className="separator">|</span>{flightInfo.duration}</>}
            {flightInfo.maxAlt && <><span className="separator">|</span>Max: {flightInfo.maxAlt}</>}
            {flightInfo.task && <><span className="separator">|</span>{flightInfo.task}</>}
          </>
        ) : (
          <span>Load an IGC file to see flight info</span>
        )}
      </div>

      {/* Filters */}
      <div className="event-panel-filters">
        <label className="switch">
          <Switch.Root
            className="switch-root"
            checked={filterVisibleEvents}
            onCheckedChange={setFilterVisibleEvents}
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          <span>Show only visible events</span>
        </label>
      </div>

      {/* Stats */}
      <div className="event-panel-stats">
        <span className="event-count">
          {filterVisibleEvents && events.length > 0
            ? `${filteredEvents.length} of ${events.length} events`
            : `${events.length} events`}
        </span>
      </div>

      {/* Event List */}
      <ScrollArea.Root className="scroll-area event-panel-list">
        <ScrollArea.Viewport className="scroll-viewport">
          {filteredEvents.length === 0 ? (
            <div className="event-empty">
              {events.length === 0
                ? 'Load an IGC file to see events'
                : 'No events in current view'}
            </div>
          ) : (
            <div className="event-timeline">
              {filteredEvents.map((event) => {
                const style = getEventStyle(event.type);
                const isSelected = selectedEvent?.id === event.id;

                return (
                  <button
                    key={event.id}
                    className={`event-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleEventClick(event)}
                  >
                    <span className="event-icon" style={{ color: style.color }}>
                      <EventIcon type={event.type} />
                    </span>
                    <div className="event-content">
                      <span className="event-type">{getEventTypeLabel(event.type)}</span>
                      <span className="event-desc">{event.description}</span>
                      <span className="event-meta">
                        {formatTime(event.time)} | {event.altitude.toFixed(0)}m
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
