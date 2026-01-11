import { describe, it, expect } from 'vitest';
import { parseXCTask, getSSSIndex, getESSIndex, calculateTaskDistance } from '../pages/src/analysis/xctsk-parser';

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

    it('should calculate task distance', () => {
      const distance = calculateTaskDistance(task);
      // Should be > 0 and roughly 100km for this task
      expect(distance).toBeGreaterThan(50000);
      expect(distance).toBeLessThan(200000);
    });
  });
});
