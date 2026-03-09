import { describe, it, expect } from 'bun:test';
import { parseIGC } from '../src/igc-parser';

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

    it('should sanitize HTML in pilot name and other headers', () => {
      const igcContent = `HFDTE150124
HFPLTPILOTINCHARGE:<script>alert(1)</script>
HFGTYGLIDERTYPE:<img src=x onerror=alert(1)>Boom
B1234564728234N01152432EA0123401567
`;

      const result = parseIGC(igcContent);

      expect(result.header.pilot).toBe('alert(1)');
      expect(result.header.gliderType).toBe('Boom');
    });

    it('should sanitize HTML in C record waypoint names', () => {
      const igcContent = `HFDTE150124
C4728234N01152432E<b>Start</b>
C4729000N01153000EGoal
B1234564728234N01152432EA0123401567
`;

      const result = parseIGC(igcContent);

      expect(result.task).toBeDefined();
      expect(result.task!.takeoff!.name).toBe('Start');
      expect(result.task!.takeoff!.name).not.toContain('<');
    });

    it('should handle midnight UTC rollover', () => {
      const igcContent = `HFDTE150124
B2358004728234N01152432EA0123401567
B2359004728300N01152500EA0125001600
B0001004728400N01152600EA0126001650
B0002004728500N01152700EA0127001700
`;

      const result = parseIGC(igcContent);
      expect(result.fixes).toHaveLength(4);

      // Timestamps must be monotonically increasing
      for (let i = 1; i < result.fixes.length; i++) {
        expect(result.fixes[i].time.getTime()).toBeGreaterThan(
          result.fixes[i - 1].time.getTime()
        );
      }

      // Pre-midnight fixes should be on Jan 15
      expect(result.fixes[0].time.getUTCDate()).toBe(15);
      expect(result.fixes[1].time.getUTCDate()).toBe(15);

      // Post-midnight fixes should be on Jan 16
      expect(result.fixes[2].time.getUTCDate()).toBe(16);
      expect(result.fixes[3].time.getUTCDate()).toBe(16);
    });

    it('should handle E records interleaved across midnight', () => {
      const igcContent = `HFDTE150124
B2358004728234N01152432EA0123401567
E235900PEVBefore midnight
B2359004728300N01152500EA0125001600
B0001004728400N01152600EA0126001650
E000200PEVAfter midnight
`;

      const result = parseIGC(igcContent);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].time.getUTCDate()).toBe(15);
      expect(result.events[1].time.getUTCDate()).toBe(16);

      // Event after midnight must be after event before midnight
      expect(result.events[1].time.getTime()).toBeGreaterThan(
        result.events[0].time.getTime()
      );
    });

    it('should not false-trigger midnight rollover on normal daytime flights', () => {
      const igcContent = `HFDTE150124
B1000004728234N01152432EA0123401567
B1100004728300N01152500EA0125001600
B1200004728400N01152600EA0126001650
`;

      const result = parseIGC(igcContent);
      expect(result.fixes).toHaveLength(3);

      // All fixes should be on the same day
      for (const fix of result.fixes) {
        expect(fix.time.getUTCDate()).toBe(15);
      }
    });

    it('should parse area task C records with OZ parameters', () => {
      const igcContent = `HFDTE150124
C3826766S14413898E00000000000400000000360000STARTAREA Bells_Beach
C3826766S14413898E00000000000750000000360000TURNAREA Aireys_Inlet
C3826766S14413898E00000000000100000000360000FINISHAREA Wild_Dog_Creek_LZ
`;

      const result = parseIGC(igcContent);
      expect(result.task).toBeDefined();

      // Takeoff is the first C record
      const takeoff = result.task!.takeoff!;
      expect(takeoff.name).toBe('Bells Beach');
      expect(takeoff.areaOZ).toBeDefined();
      expect(takeoff.areaOZ!.innerRadius).toBe(0);
      expect(takeoff.areaOZ!.outerRadius).toBe(400);
      expect(takeoff.areaOZ!.bearing1).toBe(0);
      expect(takeoff.areaOZ!.bearing2).toBe(360);
      expect(takeoff.areaOZ!.areaType).toBe('STARTAREA');

      // Start is the second C record
      const start = result.task!.start!;
      expect(start.name).toBe('Aireys Inlet');
      expect(start.areaOZ!.outerRadius).toBe(750);
      expect(start.areaOZ!.areaType).toBe('TURNAREA');

      // Landing is the last C record (only 3 points)
      const landing = result.task!.landing!;
      expect(landing.name).toBe('Wild Dog Creek LZ');
      expect(landing.areaOZ!.outerRadius).toBe(100);
      expect(landing.areaOZ!.areaType).toBe('FINISHAREA');
    });

    it('should not parse non-area C records as area tasks', () => {
      const igcContent = `HFDTE010125
C4728234N01152432ETakeoff
C4730000N01155000ESSS Start
`;

      const result = parseIGC(igcContent);
      expect(result.task!.takeoff!.name).toBe('Takeoff');
      expect(result.task!.takeoff!.areaOZ).toBeUndefined();
      expect(result.task!.start!.name).toBe('SSS Start');
      expect(result.task!.start!.areaOZ).toBeUndefined();
    });

    it('should sanitize HTML in E record event descriptions', () => {
      const igcContent = `HFDTE150124
B1234564728234N01152432EA0123401567
E123456PEV<script>xss</script>
`;

      const result = parseIGC(igcContent);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].description).toBe('xss');
      expect(result.events[0].description).not.toContain('<script>');
    });
  });

});
