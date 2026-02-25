import { describe, it, expect } from 'bun:test';
import {
  parseWaypointsCSV,
  findWaypointByName,
  findWaypointByCoordinates,
  findWaypoint,
  type WaypointRecord,
} from '../src/waypoints';

const sampleCSV = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
ELLIOT,-36.185833,147.976667,Launch,5000,935
HALFWY,-36.265473,147.873444,Half Way Hill,400,818
CUDGWE,-36.223183,147.728800,CUDGWE,400,432
NCORGL,-36.177753,147.924060,North Corry Goal,1000,277
KANGCK,-36.264100,147.938467,KANGCK,400,376`;

describe('Waypoints Module', () => {
  describe('parseWaypointsCSV', () => {
    it('should parse a valid CSV file', () => {
      const waypoints = parseWaypointsCSV(sampleCSV);

      expect(waypoints).toHaveLength(5);
      expect(waypoints[0].name).toBe('ELLIOT');
      expect(waypoints[0].latitude).toBeCloseTo(-36.185833, 5);
      expect(waypoints[0].longitude).toBeCloseTo(147.976667, 5);
      expect(waypoints[0].description).toBe('Launch');
      expect(waypoints[0].radius).toBe(5000);
      expect(waypoints[0].altitude).toBe(935);
    });

    it('should handle empty CSV', () => {
      expect(parseWaypointsCSV('')).toEqual([]);
      expect(parseWaypointsCSV('Name,Latitude,Longitude,Description,Proximity Distance,Altitude')).toEqual([]);
    });

    it('should skip invalid rows', () => {
      const csvWithBadRow = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
ELLIOT,-36.185833,147.976667,Launch,5000,935
BAD,invalid,data
HALFWY,-36.265473,147.873444,Half Way Hill,400,818`;

      const waypoints = parseWaypointsCSV(csvWithBadRow);
      expect(waypoints).toHaveLength(2);
      expect(waypoints[0].name).toBe('ELLIOT');
      expect(waypoints[1].name).toBe('HALFWY');
    });

    it('should use default radius for invalid values', () => {
      const csv = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
TEST,-36.0,147.0,Test,invalid,100`;

      const waypoints = parseWaypointsCSV(csv);
      expect(waypoints[0].radius).toBe(400);
    });
  });

  describe('findWaypointByName', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should find by exact name match', () => {
      const wp = findWaypointByName(waypoints, 'ELLIOT');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find by case-insensitive match', () => {
      const wp = findWaypointByName(waypoints, 'elliot');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find with START prefix', () => {
      const wp = findWaypointByName(waypoints, 'START ELLIOT');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find with TURN prefix', () => {
      const wp = findWaypointByName(waypoints, 'TURN HALFWY');
      expect(wp?.name).toBe('HALFWY');
    });

    it('should find with FINISH prefix', () => {
      const wp = findWaypointByName(waypoints, 'FINISH NCORGL');
      expect(wp?.name).toBe('NCORGL');
    });

    it('should return undefined for non-existent waypoint', () => {
      const wp = findWaypointByName(waypoints, 'NONEXISTENT');
      expect(wp).toBeUndefined();
    });
  });

  describe('findWaypointByCoordinates', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should find waypoint within tolerance', () => {
      // ELLIOT is at -36.185833, 147.976667
      const wp = findWaypointByCoordinates(waypoints, -36.185833, 147.976667, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find closest waypoint when multiple within tolerance', () => {
      // Create waypoints close together
      const closeWaypoints: WaypointRecord[] = [
        { name: 'A', latitude: -36.0, longitude: 147.0, description: 'A', radius: 400, altitude: 100 },
        { name: 'B', latitude: -36.0001, longitude: 147.0001, description: 'B', radius: 400, altitude: 100 },
      ];

      // Search at exact position of B
      const wp = findWaypointByCoordinates(closeWaypoints, -36.0001, 147.0001, 100);
      expect(wp?.name).toBe('B');
    });

    it('should return undefined when no waypoint within tolerance', () => {
      const wp = findWaypointByCoordinates(waypoints, 0, 0, 50);
      expect(wp).toBeUndefined();
    });
  });

  describe('findWaypoint', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should prefer name match over coordinate match', () => {
      // Search with name that matches ELLIOT but coords of HALFWY
      const wp = findWaypoint(waypoints, 'ELLIOT', -36.265473, 147.873444, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should fall back to coordinate match when name not found', () => {
      // Search with unknown name but coords of ELLIOT
      const wp = findWaypoint(waypoints, 'UNKNOWN', -36.185833, 147.976667, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should return undefined when neither match works', () => {
      const wp = findWaypoint(waypoints, 'UNKNOWN', 0, 0, 50);
      expect(wp).toBeUndefined();
    });
  });
});
