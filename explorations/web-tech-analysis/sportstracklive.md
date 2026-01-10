Web Technologies Analysis: SportsTrackLive 3D Viewer
I've analyzed the SportsTrackLive hang gliding tracker page. Here's a comprehensive breakdown of the technologies used:
3D Mapping & Visualization

Cesium.js - The primary 3D geospatial visualization engine powering the interactive 3D flight tracking view. The page uses Cesium Ion for cloud-hosted features
Leaflet.js - Lightweight mapping library, likely used for auxiliary map features
Supporting components include runtime, polyfills, and Cesium-specific stylesheets bundled at /cesium/

Frontend Framework & Architecture

Angular.js - Primary frontend framework (indicated by zone.js references in window object)
Stimulus.js - Rails-based JavaScript framework for DOM interaction (detected via data-controller="scene" attribute)
Bootstrap - CSS framework for responsive UI components
Font Awesome 5.11.2 - Icon library for UI elements

Charts & Data Visualization

ApexCharts - Advanced charting library (visible in altitude/performance graphs)
Chart.js - Additional charting capabilities for data representation

Build & Deployment

Vite - Modern build tool and development server (assets served from /vite/assets/)
Separate ES2018 and ES5 builds for broader browser compatibility
Multiple runtime and polyfill bundles for optimal performance across browser versions

API Infrastructure

REST API: https://api.sportstracklive.com - Handles data queries and user operations
WebSocket API: wss://api.sportstracklive.com:443/socket - Real-time flight tracking via Action Cable (Rails WebSocket implementation)
CSRF Protection - Authentication token system for security

External Services

Facebook SDK - Social media integration
Cesium Ion - Cloud-based 3D geospatial data platform
Microsoft Bing Maps - Satellite/aerial imagery data
USGS/Maxar/Airbus/CNES - Geospatial data attribution (satellite imagery sources)

Key Features

Free camera mode with real-time position tracking
Wind visualization and flight path overlays
Timeline scrubbing with playback controls
Live chat comments system
Premium subscription gateway

This is a sophisticated 3D web application combining real-time data streaming, geospatial visualization, and interactive replay capabilities for sports tracking.
