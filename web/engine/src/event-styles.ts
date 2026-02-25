/**
 * Event Styles
 *
 * Maps flight event types to visual presentation (icons and colors).
 * Separated from event-detector.ts as a pure UI/presentation concern.
 */

import type { FlightEventType } from './event-detector';

/**
 * Get event icon/color based on type
 */
export function getEventStyle(type: FlightEventType): {
  icon: string;
  color: string;
} {
  switch (type) {
    case 'takeoff':
      return { icon: 'plane-departure', color: '#22c55e' };
    case 'landing':
      return { icon: 'plane-arrival', color: '#ef4444' };
    case 'thermal_entry':
      return { icon: 'arrow-up', color: '#f97316' };
    case 'thermal_exit':
      return { icon: 'arrow-down', color: '#f97316' };
    case 'glide_start':
      return { icon: 'arrow-right', color: '#3b82f6' };
    case 'glide_end':
      return { icon: 'arrow-right', color: '#3b82f6' };
    case 'turnpoint_entry':
      return { icon: 'map-pin', color: '#a855f7' };
    case 'turnpoint_exit':
      return { icon: 'map-pin', color: '#a855f7' };
    case 'start_crossing':
      return { icon: 'flag', color: '#22c55e' };
    case 'goal_crossing':
      return { icon: 'trophy', color: '#eab308' };
    case 'start_reaching':
      return { icon: 'flag', color: '#16a34a' };
    case 'turnpoint_reaching':
      return { icon: 'check-circle', color: '#7c3aed' };
    case 'ess_reaching':
      return { icon: 'check-circle', color: '#dc2626' };
    case 'goal_reaching':
      return { icon: 'trophy', color: '#ca8a04' };
    case 'max_altitude':
      return { icon: 'mountain', color: '#06b6d4' };
    case 'min_altitude':
      return { icon: 'valley', color: '#64748b' };
    case 'max_climb':
      return { icon: 'trending-up', color: '#22c55e' };
    case 'max_sink':
      return { icon: 'trending-down', color: '#ef4444' };
    case 'circle_complete':
      return { icon: 'rotate-cw', color: '#8b5cf6' };
    default:
      return { icon: 'circle', color: '#64748b' };
  }
}
