/**
 * Main App Component
 *
 * The root component for the IGC analysis application.
 * Manages layout, theming, and component composition.
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { Header } from './Header';
import { EventPanel } from './EventPanel';
import { LeafletMap } from './LeafletMap';
import { MapboxMap } from './MapboxMap';

// Icons
const CloudUploadIcon = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
  </svg>
);

export function App() {
  const {
    viewMode,
    theme,
    mapProvider,
    loadIGCFile,
    loadTask,
    showStatus,
  } = useAppContext();

  const [isDragOver, setIsDragOver] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Load from query params on mount
  useEffect(() => {
    const loadFromQueryParams = async () => {
      const params = new URLSearchParams(window.location.search);
      const taskCode = params.get('task');
      const trackFile = params.get('track');

      // Load task first if specified
      if (taskCode) {
        await loadTask(taskCode);
      }

      // Load track from samples folder if specified
      if (trackFile) {
        const safeFilenamePattern = /^[a-zA-Z0-9_\-\.]+\.igc$/i;
        if (!safeFilenamePattern.test(trackFile) || trackFile.includes('..')) {
          console.error('Invalid track filename:', trackFile);
          return;
        }

        try {
          const response = await fetch(`/samples/${trackFile}`);
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
    };

    loadFromQueryParams();
  }, [loadIGCFile, loadTask]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only hide if leaving the container entirely
    const relatedTarget = e.relatedTarget as Node;
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) {
      return;
    }
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const file = e.dataTransfer?.files[0];
    if (file && file.name.toLowerCase().endsWith('.igc')) {
      await loadIGCFile(file);
    } else {
      showStatus('Please drop an IGC file', 'warning');
    }
  }, [loadIGCFile, showStatus]);

  // Determine CSS classes for main container
  const mainClasses = ['main', `view-${viewMode}`].join(' ');

  return (
    <div className="app">
      <Header />

      <main className={mainClasses}>
        {/* Map container */}
        <div
          className="map-container"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drop zone overlay */}
          <div className={`drop-zone ${isDragOver ? 'drag-over' : ''}`}>
            <div className="drop-zone-content">
              <CloudUploadIcon />
              <p>Drop IGC file here</p>
            </div>
          </div>

          {/* Map */}
          {mapProvider === 'leaflet' ? (
            <LeafletMap />
          ) : (
            <MapboxMap />
          )}

          {/* Status overlay */}
          <StatusOverlay />
        </div>

        {/* Sidebar / Event panel */}
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <EventPanel />
        </aside>
      </main>

      {/* Mobile drawer toggle (for smaller screens) */}
      {viewMode !== 'list' && (
        <MobileDrawerToggle
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
        />
      )}
    </div>
  );
}

// Status overlay component
function StatusOverlay() {
  const { statusMessage, showStatus } = useAppContext();

  if (!statusMessage) return null;

  const getIcon = () => {
    switch (statusMessage.variant) {
      case 'success': return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5z"/>
        </svg>
      );
      case 'warning': return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
        </svg>
      );
      case 'danger': return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
          <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z"/>
        </svg>
      );
      default: return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
          <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
        </svg>
      );
    }
  };

  return (
    <div className="map-overlay">
      <div className={`alert alert-${statusMessage.variant}`}>
        {getIcon()}
        <span>{statusMessage.text}</span>
        <button className="alert-close" onClick={() => showStatus('', 'primary')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// Mobile drawer toggle button
function MobileDrawerToggle({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }) {
  return (
    <button
      className="mobile-drawer-toggle"
      onClick={onToggle}
      aria-label={isOpen ? 'Close panel' : 'Open panel'}
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 48,
        height: 48,
        borderRadius: '50%',
        background: 'var(--color-primary)',
        border: 'none',
        color: 'white',
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        display: 'none', // Hidden by default, shown via media query
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        {isOpen ? (
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        ) : (
          <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
        )}
      </svg>
    </button>
  );
}
