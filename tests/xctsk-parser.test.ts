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
