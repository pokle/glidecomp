import { describe, it, expect } from 'vitest';
import { parseIGC, haversineDistance, getBoundingBox, IGCFix } from '../pages/src/analysis/igc-parser';

describe('IGC Parser', () => {
  describe('parseIGC', () => {
    it('should parse a minimal IGC file', () => {
      const igcContent = `AXXX001 FLIGHT RECORDER SERIAL NUMBER
HFDTE150124
HFPLTPILOTINCHARGE:John Doe
HFGTYGLIDERTYPE:Advance Omega X-Alps 3
B1234564728234N01152432EA0123401567
B1234574728300N01152500EA0125001600
`;

      const result = parseIGC(igcContent);

      expect(result.header.date).toBeDefined();
      expect(result.header.date?.getUTCDate()).toBe(15);
      expect(result.header.date?.getUTCMonth()).toBe(0); // January (0-indexed)
      expect(result.header.date?.getUTCFullYear()).toBe(2024);
      expect(result.header.pilot).toBe('John Doe');
      expect(result.header.gliderType).toBe('Advance Omega X-Alps 3');
      expect(result.fixes).toHaveLength(2);
    });

    it('should parse B records correctly', () => {
      const igcContent = `HFDTE010125
B1230004728234N01152432EA0123401567
`;

      const result = parseIGC(igcContent);
      const fix = result.fixes[0];

      expect(fix.time.getUTCHours()).toBe(12);
      expect(fix.time.getUTCMinutes()).toBe(30);
      expect(fix.time.getUTCSeconds()).toBe(0);

      // Latitude: 47 degrees, 28.234 minutes = 47 + 28.234/60 = 47.47056...
      expect(fix.latitude).toBeCloseTo(47.4706, 3);

      // Longitude: 011 degrees, 52.432 minutes = 11 + 52.432/60 = 11.8739...
      expect(fix.longitude).toBeCloseTo(11.8739, 3);

      expect(fix.valid).toBe(true);
      expect(fix.pressureAltitude).toBe(1234);
      expect(fix.gnssAltitude).toBe(1567);
    });

    it('should parse Southern and Western coordinates', () => {
      const igcContent = `HFDTE010125
B1230004728234S01152432WA0123401567
`;

      const result = parseIGC(igcContent);
      const fix = result.fixes[0];

      expect(fix.latitude).toBeLessThan(0);
      expect(fix.longitude).toBeLessThan(0);
      expect(fix.latitude).toBeCloseTo(-47.4706, 3);
      expect(fix.longitude).toBeCloseTo(-11.8739, 3);
    });

    it('should parse invalid fixes (V flag)', () => {
      const igcContent = `HFDTE010125
B1230004728234N01152432EV0123401567
`;

      const result = parseIGC(igcContent);
      expect(result.fixes[0].valid).toBe(false);
    });

    it('should handle dates in 1900s and 2000s', () => {
      const igc2024 = `HFDTE150124`;
      const igc1999 = `HFDTE150199`;

      const result2024 = parseIGC(igc2024);
      const result1999 = parseIGC(igc1999);

      expect(result2024.header.date?.getUTCFullYear()).toBe(2024);
      expect(result1999.header.date?.getUTCFullYear()).toBe(1999);
    });

    it('should parse E records (events)', () => {
      const igcContent = `HFDTE010125
B1230004728234N01152432EA0123401567
E123045PEVPilot Event
`;

      const result = parseIGC(igcContent);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].code).toBe('PEV');
      expect(result.events[0].description).toBe('Pilot Event');
    });

    it('should parse C records (task declaration)', () => {
      const igcContent = `HFDTE010125
C4728234N01152432ETakeoff
C4730000N01155000ESSS Start
C4735000N01160000ETP1
C4740000N01165000EESS Goal
C4745000N01170000ELanding
`;

      const result = parseIGC(igcContent);
      expect(result.task).toBeDefined();
      expect(result.task!.takeoff).toBeDefined();
      expect(result.task!.takeoff!.name).toBe('Takeoff');
      expect(result.task!.start).toBeDefined();
      expect(result.task!.start!.name).toBe('SSS Start');
      expect(result.task!.turnpoints).toHaveLength(1);
      expect(result.task!.finish).toBeDefined();
      expect(result.task!.landing).toBeDefined();
    });

    it('should handle various H record formats', () => {
      const igcContent = `HFDTE:150124
HFPLT:Jane Smith
HFGTY:Nova Mentor 7
HFGID:12345
HFCID:AB
HFCCL:Sport
`;

      const result = parseIGC(igcContent);
      expect(result.header.pilot).toBe('Jane Smith');
      expect(result.header.gliderType).toBe('Nova Mentor 7');
      expect(result.header.gliderId).toBe('12345');
      expect(result.header.competitionId).toBe('AB');
      expect(result.header.competitionClass).toBe('Sport');
    });
  });

  describe('haversineDistance', () => {
    it('should calculate distance between two points', () => {
      // Distance from Big Ben to Eiffel Tower is approximately 344 km
      const londonLat = 51.5007;
      const londonLon = -0.1246;
      const parisLat = 48.8584;
      const parisLon = 2.2945;

      const distance = haversineDistance(londonLat, londonLon, parisLat, parisLon);

      // Allow for some tolerance (within 5km)
      expect(distance).toBeGreaterThan(339000);
      expect(distance).toBeLessThan(349000);
    });

    it('should return 0 for same point', () => {
      const distance = haversineDistance(47.0, 11.0, 47.0, 11.0);
      expect(distance).toBe(0);
    });
  });

  describe('getBoundingBox', () => {
    it('should calculate bounding box for fixes', () => {
      const fixes: IGCFix[] = [
        { time: new Date(), latitude: 47.0, longitude: 11.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true },
        { time: new Date(), latitude: 48.0, longitude: 12.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true },
        { time: new Date(), latitude: 47.5, longitude: 11.5, pressureAltitude: 1000, gnssAltitude: 1000, valid: true },
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(47.0);
      expect(bounds.maxLat).toBe(48.0);
      expect(bounds.minLon).toBe(11.0);
      expect(bounds.maxLon).toBe(12.0);
    });

    it('should return zeros for empty fixes array', () => {
      const bounds = getBoundingBox([]);

      expect(bounds.minLat).toBe(0);
      expect(bounds.maxLat).toBe(0);
      expect(bounds.minLon).toBe(0);
      expect(bounds.maxLon).toBe(0);
    });
  });
});
