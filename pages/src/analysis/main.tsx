/**
 * IGC Analysis Tool - React Entry Point
 *
 * Main entry point for the React application.
 * Sets up the React root and renders the app with context providers.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import { App } from './components/App';
import './styles/app.css';

// CSS for Mapbox GL
import 'mapbox-gl/dist/mapbox-gl.css';

// Initialize the React application
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
