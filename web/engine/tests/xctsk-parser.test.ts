import { describe, it, expect } from 'bun:test';
import { parseXCTask, getSSSIndex, getESSIndex, calculateNominalTaskDistance, igcTaskToXCTask, isValidTask, toXctskJSON } from '../src/xctsk-parser';
import type { IGCTask } from '../src/igc-parser';

describe('XCTSK Parser', () => {
  describe('parseXCTask v1 format', () => {
    it('should parse a basic v1 task', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        earthModel: 'WGS84',
        turnpoints: [
          {
            type: 'SSS',
            radius: 400,
            waypoint: { name: 'Start', lat: 47.0, lon: 11.0 }
          },
          {
            radius: 1000,
            waypoint: { name: 'TP1', lat: 47.5, lon: 11.5 }
          },
          {
            type: 'ESS',
            radius: 400,
            waypoint: { name: 'Goal', lat: 48.0, lon: 12.0 }
          }
        ]
      });

      const task = parseXCTask(taskJson);

      expect(task.taskType).toBe('CLASSIC');
      expect(task.version).toBe(1);
      expect(task.earthModel).toBe('WGS84');
      expect(task.turnpoints).toHaveLength(3);
      expect(task.turnpoints[0].type).toBe('SSS');
      expect(task.turnpoints[0].waypoint.name).toBe('Start');
      expect(task.turnpoints[1].radius).toBe(1000);
      expect(task.turnpoints[2].type).toBe('ESS');
    });

    it('should parse task with SSS and goal configuration', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { type: 'SSS', radius: 400, waypoint: { name: 'Start', lat: 47.0, lon: 11.0 } },
          { type: 'ESS', radius: 400, waypoint: { name: 'Goal', lat: 48.0, lon: 12.0 } }
        ],
        sss: {
          type: 'RACE',
          direction: 'ENTER',
          timeGates: ['12:00:00Z', '12:30:00Z']
        },
        goal: {
          type: 'LINE',
          deadline: '18:00:00Z'
        }
      });

      const task = parseXCTask(taskJson);

      expect(task.sss).toBeDefined();
      expect(task.sss!.type).toBe('RACE');
      expect(task.sss!.direction).toBe('ENTER');
      expect(task.sss!.timeGates).toHaveLength(2);
      expect(task.goal).toBeDefined();
      expect(task.goal!.type).toBe('LINE');
    });
  });

  describe('parseXCTask v2 format (QR code)', () => {
    it('should remove XCTSK: prefix', () => {
      const taskStr = `XCTSK:{"taskType":"CLASSIC","version":2,"t":[{"n":"TP1","lat":47.0,"lon":11.0,"r":400}]}`;

      const task = parseXCTask(taskStr);

      expect(task.taskType).toBe('CLASSIC');
      expect(task.version).toBe(2);
    });

    it('should parse compact turnpoint format', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 2,
        t: [
          { n: 'Start', lat: 47.0, lon: 11.0, r: 400, y: 'S' },
          { n: 'TP1', lat: 47.5, lon: 11.5, r: 1000 },
          { n: 'Goal', lat: 48.0, lon: 12.0, r: 400, y: 'E' }
        ],
        s: { t: 1, d: 1 },
        g: { t: 1 }
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints).toHaveLength(3);
      expect(task.turnpoints[0].type).toBe('SSS');
      expect(task.turnpoints[0].waypoint.name).toBe('Start');
      expect(task.turnpoints[2].type).toBe('ESS');
      expect(task.sss?.type).toBe('RACE');
      expect(task.goal?.type).toBe('LINE');
    });

    it('should handle FAI sphere earth model', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 2,
        t: [{ n: 'TP', lat: 47.0, lon: 11.0, r: 400 }],
        e: 1
      });

      const task = parseXCTask(taskJson);
      expect(task.earthModel).toBe('FAI_SPHERE');
    });
  });

  describe('real-world tasks', () => {
    it('should parse the XContest "face" task correctly', () => {
      // Real task from xcontest.org with code 'face'
      const taskJson = `{"earthModel":"WGS84","goal":{"deadline":"08:00:00Z","type":"CYLINDER"},"sss":{"direction":"EXIT","timeGates":["03:00:00Z","03:15:00Z","03:30:00Z","03:45:00Z","04:00:00Z","04:15:00Z","04:30:00Z","04:45:00Z","05:00:00Z","05:15:00Z"],"type":"RACE"},"taskType":"CLASSIC","turnpoints":[{"radius":3000,"type":"SSS","waypoint":{"altSmoothed":932,"description":"ELLIOT","lat":-36.18583297729492,"lon":147.97666931152344,"name":"ELLIOT"}},{"radius":1500,"waypoint":{"altSmoothed":375,"description":"KANGCK","lat":-36.26409912109375,"lon":147.93846130371094,"name":"KANGCK"}},{"radius":5000,"waypoint":{"altSmoothed":309,"description":"BIGARA","lat":-36.26362609863281,"lon":148.0209503173828,"name":"BIGARA"}},{"radius":2000,"waypoint":{"altSmoothed":275,"description":"TOOMA","lat":-35.96784973144531,"lon":148.05804443359375,"name":"TOOMA"}},{"radius":400,"waypoint":{"altSmoothed":676,"description":"LIGHTH","lat":-36.086533,"lon":148.045583,"name":"LIGHTH"}},{"radius":7000,"waypoint":{"altSmoothed":407,"description":"DWYERS","lat":-36.242792,"lon":147.883678,"name":"DWYERS"}},{"radius":1000,"type":"ESS","waypoint":{"altSmoothed":289,"description":"KHANCO","lat":-36.216217041015625,"lon":148.1097869873047,"name":"KHANCO"}}],"version":1}`;

      const task = parseXCTask(taskJson);

      expect(task.taskType).toBe('CLASSIC');
      expect(task.version).toBe(1);
      expect(task.earthModel).toBe('WGS84');
      expect(task.turnpoints).toHaveLength(7);

      // Check first turnpoint (SSS)
      expect(task.turnpoints[0].type).toBe('SSS');
      expect(task.turnpoints[0].radius).toBe(3000);
      expect(task.turnpoints[0].waypoint.name).toBe('ELLIOT');
      expect(task.turnpoints[0].waypoint.lat).toBeCloseTo(-36.186, 2);
      expect(task.turnpoints[0].waypoint.lon).toBeCloseTo(147.977, 2);

      // Check last turnpoint (ESS)
      expect(task.turnpoints[6].type).toBe('ESS');
      expect(task.turnpoints[6].waypoint.name).toBe('KHANCO');

      // Check SSS config
      expect(task.sss?.type).toBe('RACE');
      expect(task.sss?.direction).toBe('EXIT');
      expect(task.sss?.timeGates).toHaveLength(10);

      // Check goal config
      expect(task.goal?.type).toBe('CYLINDER');
      expect(task.goal?.deadline).toBe('08:00:00Z');
    });

    it('should handle negative latitudes (southern hemisphere)', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: 'TP1', lat: -36.5, lon: 148.0 } },
          { radius: 400, waypoint: { name: 'TP2', lat: -35.5, lon: 149.0 } }
        ]
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints[0].waypoint.lat).toBe(-36.5);
      expect(task.turnpoints[0].waypoint.lon).toBe(148.0);
    });
  });

  describe('igcTaskToXCTask', () => {
    it('should convert a basic IGC task to XCTask', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 2,
        takeoff: { latitude: -36.186, longitude: 147.976, name: 'TAKEOFF' },
        start: { latitude: -36.186, longitude: 147.977, name: 'START ELLIOT' },
        turnpoints: [
          { latitude: -36.266, longitude: 147.873, name: 'TURN HALFWY' },
          { latitude: -36.223, longitude: 147.729, name: 'TURN CUDGWE' },
        ],
        finish: { latitude: -36.177, longitude: 147.924, name: 'FINISH NCORGL' },
        landing: { latitude: 0, longitude: 0, name: 'LANDING' },
      };

      const xcTask = igcTaskToXCTask(igcTask);

      expect(xcTask.taskType).toBe('CLASSIC');
      expect(xcTask.version).toBe(1);
      expect(xcTask.earthModel).toBe('WGS84');
      expect(xcTask.turnpoints).toHaveLength(4); // start + 2 turnpoints + finish

      // Check start is SSS
      expect(xcTask.turnpoints[0].type).toBe('SSS');
      expect(xcTask.turnpoints[0].waypoint.name).toBe('START ELLIOT');
      expect(xcTask.turnpoints[0].waypoint.lat).toBeCloseTo(-36.186, 3);
      expect(xcTask.turnpoints[0].radius).toBe(400);

      // Check intermediate turnpoints have TURNPOINT type
      expect(xcTask.turnpoints[1].type).toBe('TURNPOINT');
      expect(xcTask.turnpoints[1].waypoint.name).toBe('TURN HALFWY');
      expect(xcTask.turnpoints[2].type).toBe('TURNPOINT');
      expect(xcTask.turnpoints[2].waypoint.name).toBe('TURN CUDGWE');

      // Check finish is GOAL
      expect(xcTask.turnpoints[3].type).toBe('GOAL');
      expect(xcTask.turnpoints[3].waypoint.name).toBe('FINISH NCORGL');
    });

    it('should use area OZ outer radius instead of default', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 1,
        start: {
          latitude: -38.4, longitude: 144.2, name: 'Bells Beach',
          areaOZ: { innerRadius: 0, outerRadius: 750, bearing1: 0, bearing2: 360, areaType: 'STARTAREA' },
        },
        turnpoints: [
          {
            latitude: -38.5, longitude: 144.3, name: 'Aireys Inlet',
            areaOZ: { innerRadius: 0, outerRadius: 500, bearing1: 0, bearing2: 360, areaType: 'TURNAREA' },
          },
        ],
        finish: {
          latitude: -38.6, longitude: 144.4, name: 'Wild Dog Creek LZ',
          areaOZ: { innerRadius: 0, outerRadius: 100, bearing1: 0, bearing2: 360, areaType: 'FINISHAREA' },
        },
      };

      const xcTask = igcTaskToXCTask(igcTask);

      expect(xcTask.turnpoints[0].radius).toBe(750);
      expect(xcTask.turnpoints[0].type).toBe('SSS'); // STARTAREA confirms SSS
      expect(xcTask.turnpoints[1].radius).toBe(500);
      expect(xcTask.turnpoints[2].radius).toBe(100);
      expect(xcTask.turnpoints[2].type).toBe('GOAL'); // Finish is GOAL (FINISHAREA overrides to SSS in createTurnpoint, but initial type is GOAL)
    });

    it('should use custom radius when provided', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 0,
        start: { latitude: -36.186, longitude: 147.977, name: 'Start' },
        turnpoints: [],
        finish: { latitude: -36.177, longitude: 147.924, name: 'Finish' },
      };

      const xcTask = igcTaskToXCTask(igcTask, 1000);

      expect(xcTask.turnpoints[0].radius).toBe(1000);
      expect(xcTask.turnpoints[1].radius).toBe(1000);
    });

    it('should handle minimal task with only start and finish', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 0,
        start: { latitude: 47.0, longitude: 11.0, name: 'Start' },
        turnpoints: [],
        finish: { latitude: 48.0, longitude: 12.0, name: 'Goal' },
      };

      const xcTask = igcTaskToXCTask(igcTask);

      expect(xcTask.turnpoints).toHaveLength(2);
      expect(xcTask.turnpoints[0].type).toBe('SSS');
      expect(xcTask.turnpoints[1].type).toBe('GOAL');
    });

    it('should handle task with empty names', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 1,
        start: { latitude: 47.0, longitude: 11.0, name: '' },
        turnpoints: [
          { latitude: 47.5, longitude: 11.5, name: '' },
        ],
        finish: { latitude: 48.0, longitude: 12.0, name: '' },
      };

      const xcTask = igcTaskToXCTask(igcTask);

      expect(xcTask.turnpoints[0].waypoint.name).toBe('Start');
      expect(xcTask.turnpoints[1].waypoint.name).toBe('Turnpoint');
      expect(xcTask.turnpoints[2].waypoint.name).toBe('Finish');
    });

    it('should enrich task with waypoint database by name', () => {
      const waypoints = [
        { name: 'ELLIOT', latitude: -36.185833, longitude: 147.976667, description: 'Launch', radius: 5000, altitude: 935 },
        { name: 'HALFWY', latitude: -36.265473, longitude: 147.873444, description: 'Half Way Hill', radius: 400, altitude: 818 },
        { name: 'NCORGL', latitude: -36.177753, longitude: 147.924060, description: 'North Corry Goal', radius: 1000, altitude: 277 },
      ];

      const igcTask: IGCTask = {
        numTurnpoints: 1,
        start: { latitude: -36.186, longitude: 147.977, name: 'START ELLIOT' },
        turnpoints: [
          { latitude: -36.266, longitude: 147.873, name: 'TURN HALFWY' },
        ],
        finish: { latitude: -36.178, longitude: 147.924, name: 'FINISH NCORGL' },
      };

      const xcTask = igcTaskToXCTask(igcTask, { waypoints });

      // Check that waypoint data was enriched
      expect(xcTask.turnpoints[0].radius).toBe(5000); // ELLIOT has 5000m radius
      expect(xcTask.turnpoints[0].waypoint.name).toBe('Launch'); // Uses description
      expect(xcTask.turnpoints[0].waypoint.altSmoothed).toBe(935);

      expect(xcTask.turnpoints[1].radius).toBe(400); // HALFWY has 400m radius
      expect(xcTask.turnpoints[1].waypoint.name).toBe('Half Way Hill');
      expect(xcTask.turnpoints[1].waypoint.altSmoothed).toBe(818);

      expect(xcTask.turnpoints[2].radius).toBe(1000); // NCORGL has 1000m radius
      expect(xcTask.turnpoints[2].waypoint.name).toBe('North Corry Goal');
      expect(xcTask.turnpoints[2].waypoint.altSmoothed).toBe(277);
    });

    it('should fall back to coordinate matching when name not found', () => {
      const waypoints = [
        { name: 'ELLIOT', latitude: -36.185833, longitude: 147.976667, description: 'Launch', radius: 5000, altitude: 935 },
      ];

      const igcTask: IGCTask = {
        numTurnpoints: 0,
        // Name doesn't match, but coordinates are within 50m of ELLIOT
        start: { latitude: -36.185833, longitude: 147.976667, name: 'UNKNOWN NAME' },
        turnpoints: [],
        finish: { latitude: 0, longitude: 0, name: 'Finish' },
      };

      const xcTask = igcTaskToXCTask(igcTask, { waypoints, coordinateTolerance: 50 });

      // Start should match by coordinates
      expect(xcTask.turnpoints[0].radius).toBe(5000);
      expect(xcTask.turnpoints[0].waypoint.name).toBe('Launch');

      // Finish should use defaults (no match)
      expect(xcTask.turnpoints[1].radius).toBe(400);
    });

    it('should use options object with defaultRadius', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 0,
        start: { latitude: 47.0, longitude: 11.0, name: 'Start' },
        turnpoints: [],
        finish: { latitude: 48.0, longitude: 12.0, name: 'Finish' },
      };

      const xcTask = igcTaskToXCTask(igcTask, { defaultRadius: 2000 });

      expect(xcTask.turnpoints[0].radius).toBe(2000);
      expect(xcTask.turnpoints[1].radius).toBe(2000);
    });
  });

  describe('parseXCTask v1 takeoff times', () => {
    it('should parse takeoff open and close times', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { type: 'SSS', radius: 400, waypoint: { name: 'Start', lat: 47.0, lon: 11.0 } },
        ],
        takeoff: {
          timeOpen: '10:00:00Z',
          timeClose: '12:00:00Z',
        },
      });

      const task = parseXCTask(taskJson);

      expect(task.takeoff).toBeDefined();
      expect(task.takeoff!.timeOpen).toBe('10:00:00Z');
      expect(task.takeoff!.timeClose).toBe('12:00:00Z');
    });
  });

  describe('parseXCTask v2 polyline-encoded coordinates', () => {
    it('should decode polyline-encoded turnpoint coordinates', () => {
      // Encode lat=47.0, lon=11.0, alt=500 using Google Polyline Algorithm:
      // lat=4700000 -> encoded, lon=1100000 -> encoded, alt=500 -> encoded
      // We'll use explicit lat/lon to verify the polyline path is exercised,
      // then check a task that uses 'z' field
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [
          { n: 'Encoded TP', z: 'o}~rH_seaA_seaA' },
        ],
      });

      const task = parseXCTask(taskJson);

      expect(task.version).toBe(2);
      expect(task.turnpoints).toHaveLength(1);
      expect(task.turnpoints[0].waypoint.name).toBe('Encoded TP');
      // The polyline decodes to some coordinates - just verify they're numbers
      expect(typeof task.turnpoints[0].waypoint.lat).toBe('number');
      expect(typeof task.turnpoints[0].waypoint.lon).toBe('number');
    });

    it('should prefer explicit lat/lon over polyline when both present', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [
          { n: 'TP', z: 'o}~rH_seaA_seaA', lat: 47.0, lon: 11.0, r: 500 },
        ],
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints[0].waypoint.lat).toBe(47.0);
      expect(task.turnpoints[0].waypoint.lon).toBe(11.0);
      expect(task.turnpoints[0].radius).toBe(500);
    });
  });

  describe('parseXCTask v2 takeoff times', () => {
    it('should parse compact takeoff open/close times', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [{ n: 'TP', lat: 47.0, lon: 11.0, r: 400 }],
        to: '10:00:00Z',
        tc: '12:00:00Z',
      });

      const task = parseXCTask(taskJson);

      expect(task.takeoff).toBeDefined();
      expect(task.takeoff!.timeOpen).toBe('10:00:00Z');
      expect(task.takeoff!.timeClose).toBe('12:00:00Z');
    });
  });

  describe('parseXCTask v2 type codes', () => {
    it('should map TAKEOFF type code', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [{ n: 'Launch', lat: 47.0, lon: 11.0, r: 0, y: 'T' }],
      });

      const task = parseXCTask(taskJson);
      expect(task.turnpoints[0].type).toBe('TAKEOFF');
    });

    it('should parse ELAPSED-TIME SSS and EXIT direction', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [{ n: 'TP', lat: 47.0, lon: 11.0, r: 400 }],
        s: { t: 0, d: 0 },
      });

      const task = parseXCTask(taskJson);
      expect(task.sss?.type).toBe('ELAPSED-TIME');
      expect(task.sss?.direction).toBe('EXIT');
    });

    it('should parse goal CYLINDER type', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [{ n: 'TP', lat: 47.0, lon: 11.0, r: 400 }],
        g: { t: 0, d: '18:00:00Z' },
      });

      const task = parseXCTask(taskJson);
      expect(task.goal?.type).toBe('CYLINDER');
      expect(task.goal?.deadline).toBe('18:00:00Z');
    });
  });

  describe('isValidTask', () => {
    it('should return false for empty turnpoints', () => {
      expect(isValidTask({ taskType: 'CLASSIC', version: 1, turnpoints: [] })).toBe(false);
    });

    it('should return false for NaN coordinates', () => {
      const task = {
        taskType: 'CLASSIC', version: 1,
        turnpoints: [{ type: 'TURNPOINT' as const, radius: 400, waypoint: { name: 'TP', lat: NaN, lon: 11.0 } }],
      };
      expect(isValidTask(task)).toBe(false);
    });

    it('should return false for out-of-range latitude', () => {
      const task = {
        taskType: 'CLASSIC', version: 1,
        turnpoints: [{ type: 'TURNPOINT' as const, radius: 400, waypoint: { name: 'TP', lat: 91, lon: 11.0 } }],
      };
      expect(isValidTask(task)).toBe(false);
    });

    it('should return false for out-of-range longitude', () => {
      const task = {
        taskType: 'CLASSIC', version: 1,
        turnpoints: [{ type: 'TURNPOINT' as const, radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 181 } }],
      };
      expect(isValidTask(task)).toBe(false);
    });

    it('should return true for valid task', () => {
      const task = {
        taskType: 'CLASSIC', version: 1,
        turnpoints: [{ type: 'TURNPOINT' as const, radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 11.0 } }],
      };
      expect(isValidTask(task)).toBe(true);
    });
  });

  describe('parseXCTask fallback branch', () => {
    it('should fall back to v1 when neither turnpoints nor t array present', () => {
      // JSON with no 'turnpoints' and no 't' — triggers fallback
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        earthModel: 'WGS84',
      });

      const task = parseXCTask(taskJson);

      // v1 parse with no turnpoints produces empty array, isValidTask returns false,
      // so it falls through to v2 which also has no turnpoints
      expect(task.turnpoints).toHaveLength(0);
    });
  });

  describe('helper functions', () => {
    const task = parseXCTask(JSON.stringify({
      taskType: 'CLASSIC',
      version: 1,
      turnpoints: [
        { type: 'TAKEOFF', radius: 0, waypoint: { name: 'Takeoff', lat: 47.0, lon: 11.0 } },
        { type: 'SSS', radius: 400, waypoint: { name: 'Start', lat: 47.1, lon: 11.1 } },
        { radius: 1000, waypoint: { name: 'TP1', lat: 47.5, lon: 11.5 } },
        { radius: 1000, waypoint: { name: 'TP2', lat: 47.7, lon: 11.7 } },
        { type: 'ESS', radius: 400, waypoint: { name: 'Goal', lat: 48.0, lon: 12.0 } }
      ]
    }));

    it('should find SSS index', () => {
      expect(getSSSIndex(task)).toBe(1);
    });

    it('should find ESS index', () => {
      expect(getESSIndex(task)).toBe(4);
    });

    it('should calculate nominal task distance', () => {
      const distance = calculateNominalTaskDistance(task);
      // Should be > 0 and roughly 100km for this task
      expect(distance).toBeGreaterThan(50000);
      expect(distance).toBeLessThan(200000);
    });
  });

  describe('XSS sanitization', () => {
    it('should sanitize HTML in v1 waypoint names and descriptions', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          {
            type: 'SSS',
            radius: 400,
            waypoint: {
              name: '<img src=x onerror=alert(1)>Start',
              description: '<script>steal(cookies)</script>',
              lat: 47.0,
              lon: 11.0,
            },
          },
          {
            type: 'ESS',
            radius: 400,
            waypoint: { name: 'Goal<b>xss</b>', lat: 48.0, lon: 12.0 },
          },
        ],
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints[0].waypoint.name).toBe('Start');
      expect(task.turnpoints[0].waypoint.name).not.toContain('<');
      expect(task.turnpoints[0].waypoint.description).toBe('steal(cookies)');
      expect(task.turnpoints[0].waypoint.description).not.toContain('<script>');
      expect(task.turnpoints[1].waypoint.name).toBe('Goalxss');
    });

    it('should sanitize HTML in v2 waypoint names', () => {
      const taskJson = JSON.stringify({
        t: [
          {
            y: 'S',
            r: 400,
            lat: 47.0,
            lon: 11.0,
            n: '<img onerror=alert(document.cookie)>TP1',
          },
        ],
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints[0].waypoint.name).toBe('TP1');
      expect(task.turnpoints[0].waypoint.name).not.toContain('<');
    });
  });

  describe('toXctskJSON', () => {
    it('should omit TURNPOINT and GOAL types from output', () => {
      const task = parseXCTask(JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { type: 'TAKEOFF', radius: 0, waypoint: { name: 'Launch', lat: 47.0, lon: 11.0 } },
          { type: 'SSS', radius: 400, waypoint: { name: 'Start', lat: 47.1, lon: 11.1 } },
          { radius: 1000, waypoint: { name: 'TP1', lat: 47.5, lon: 11.5 } },
          { type: 'ESS', radius: 400, waypoint: { name: 'Goal', lat: 48.0, lon: 12.0 } }
        ]
      }));

      const json = toXctskJSON(task);
      const tps = (json as { turnpoints: Array<Record<string, unknown>> }).turnpoints;

      expect(tps[0].type).toBe('TAKEOFF');
      expect(tps[1].type).toBe('SSS');
      expect(tps[2].type).toBeUndefined(); // was TURNPOINT internally
      expect(tps[3].type).toBe('ESS');
    });

    it('should strip GOAL type from igcTaskToXCTask output', () => {
      const igcTask: IGCTask = {
        numTurnpoints: 1,
        start: { latitude: 47.0, longitude: 11.0, name: 'Start' },
        turnpoints: [{ latitude: 47.5, longitude: 11.5, name: 'TP1' }],
        finish: { latitude: 48.0, longitude: 12.0, name: 'Goal' },
      };

      const xcTask = igcTaskToXCTask(igcTask);
      const json = toXctskJSON(xcTask);
      const tps = (json as { turnpoints: Array<Record<string, unknown>> }).turnpoints;

      // SSS is valid spec type — should be present
      expect(tps[0].type).toBe('SSS');
      // TURNPOINT is internal — should be omitted
      expect(tps[1].type).toBeUndefined();
      // GOAL is internal — should be omitted
      expect(tps[2].type).toBeUndefined();
    });

    it('should default altSmoothed to 0 when missing', () => {
      const task = parseXCTask(JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 11.0 } }
        ]
      }));

      const json = toXctskJSON(task);
      const wp = (json as { turnpoints: Array<{ waypoint: { altSmoothed: number } }> }).turnpoints[0].waypoint;

      expect(wp.altSmoothed).toBe(0);
    });

    it('should default timeGates to ["00:00:00Z"] when missing', () => {
      const task = parseXCTask(JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { type: 'SSS', radius: 400, waypoint: { name: 'Start', lat: 47.0, lon: 11.0 } },
        ],
        sss: { type: 'RACE', direction: 'EXIT' }
      }));

      const json = toXctskJSON(task);
      const sss = (json as { sss: { timeGates: string[] } }).sss;

      expect(sss.timeGates).toEqual(['00:00:00Z']);
    });

    it('should include finishAltitude in goal when set', () => {
      const task = parseXCTask(JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 11.0 } }
        ],
        goal: { type: 'CYLINDER', finishAltitude: 200 }
      }));

      const json = toXctskJSON(task);
      const goal = (json as { goal: { finishAltitude: number } }).goal;

      expect(goal.finishAltitude).toBe(200);
    });

    it('should omit cylinderTolerance from output', () => {
      const task = parseXCTask(JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 11.0 } }
        ]
      }));
      task.cylinderTolerance = 0.005;

      const json = toXctskJSON(task);
      expect((json as Record<string, unknown>).cylinderTolerance).toBeUndefined();
    });

    it('should round-trip xcontest task with minimal diff', () => {
      const originalJson = `{"earthModel":"WGS84","goal":{"deadline":"08:00:00Z","type":"CYLINDER"},"sss":{"direction":"EXIT","timeGates":["03:00:00Z"],"type":"RACE"},"taskType":"CLASSIC","turnpoints":[{"radius":3000,"type":"SSS","waypoint":{"altSmoothed":932,"description":"ELLIOT","lat":-36.186,"lon":147.977,"name":"ELLIOT"}},{"radius":1000,"type":"ESS","waypoint":{"altSmoothed":289,"description":"KHANCO","lat":-36.216,"lon":148.110,"name":"KHANCO"}}],"version":1}`;

      const task = parseXCTask(originalJson);
      const exported = toXctskJSON(task);

      const tps = (exported as { turnpoints: Array<Record<string, unknown>> }).turnpoints;
      expect(tps[0].type).toBe('SSS');
      expect(tps[1].type).toBe('ESS');
      expect((exported as Record<string, unknown>).version).toBe(1);
      expect((exported as { sss: { timeGates: string[] } }).sss.timeGates).toEqual(['03:00:00Z']);
    });
  });

  describe('parseXCTask v2 numeric type codes', () => {
    it('should parse numeric type t=2 as SSS and t=3 as ESS', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 2,
        t: [
          { n: 'Start', lat: 47.0, lon: 11.0, r: 400, t: 2 },
          { n: 'TP1', lat: 47.5, lon: 11.5, r: 1000 },
          { n: 'Goal', lat: 48.0, lon: 12.0, r: 400, t: 3 }
        ],
      });

      const task = parseXCTask(taskJson);

      expect(task.turnpoints[0].type).toBe('SSS');
      expect(task.turnpoints[1].type).toBe('TURNPOINT');
      expect(task.turnpoints[2].type).toBe('ESS');
    });
  });

  describe('goal.finishAltitude', () => {
    it('should parse finishAltitude in v1 format', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          { radius: 400, waypoint: { name: 'TP', lat: 47.0, lon: 11.0 } }
        ],
        goal: { type: 'CYLINDER', deadline: '18:00:00Z', finishAltitude: 150 }
      });

      const task = parseXCTask(taskJson);
      expect(task.goal?.finishAltitude).toBe(150);
    });

    it('should parse finishAltitude (fa) in v2 format', () => {
      const taskJson = JSON.stringify({
        taskType: 'CLASSIC',
        t: [{ n: 'TP', lat: 47.0, lon: 11.0, r: 400 }],
        g: { t: 2, d: '18:00:00Z', fa: 200 }
      });

      const task = parseXCTask(taskJson);
      expect(task.goal?.finishAltitude).toBe(200);
    });
  });
});
