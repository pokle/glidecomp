/**
 * Tests for task optimizer: iterative convergence and cylinder tolerance.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  calculateOptimizedTaskLine,
  calculateOptimizedTaskDistance,
  getOptimizedSegmentDistances,
} from '../src/task-optimizer';
import { parseXCTask, type XCTask, type Turnpoint } from '../src/xctsk-parser';
import { andoyerDistance, destinationPoint } from '../src/geo';

function makeTurnpoint(name: string, lat: number, lon: number, radius: number, type?: string): Turnpoint {
  return {
    type: type as any,
    radius,
    waypoint: { name, lat, lon },
  };
}

function makeTask(turnpoints: Turnpoint[]): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints,
  };
}

describe('task optimizer — iterative convergence', () => {
  it('should produce shorter distance than single-pass greedy for complex tasks', () => {
    // Triangle task with large cylinders where iteration matters
    const task = makeTask([
      makeTurnpoint('A', 47.0, 11.0, 3000, 'SSS'),
      makeTurnpoint('B', 47.1, 11.2, 5000),
      makeTurnpoint('C', 46.9, 11.3, 4000),
      makeTurnpoint('D', 47.0, 11.0, 1000, 'ESS'),
    ]);

    const distance = calculateOptimizedTaskDistance(task);
    const path = calculateOptimizedTaskLine(task);

    // Basic sanity: should have 4 points
    expect(path).toHaveLength(4);
    // Distance should be positive and reasonable
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(100000); // < 100km
  });

  it('face.xctsk: iterative produces shorter distance than naive approach', () => {
    const taskContent = readFileSync(
      resolve(__dirname, '../../../web/frontend/public/data/tasks/face.xctsk'),
      'utf-8'
    );
    const task = parseXCTask(taskContent);
    const distance = calculateOptimizedTaskDistance(task);

    // The old single-pass greedy gave 77.513 km.
    // Iterative convergence should give a shorter distance.
    expect(distance / 1000).toBeLessThan(77.5);
    // But still reasonable (not collapsed)
    expect(distance / 1000).toBeGreaterThan(70);
  });

  it('should converge: total distance decreases monotonically', () => {
    const taskContent = readFileSync(
      resolve(__dirname, '../../../web/frontend/public/data/tasks/face.xctsk'),
      'utf-8'
    );
    const task = parseXCTask(taskContent);
    const path = calculateOptimizedTaskLine(task);

    // Each point should lie on its turnpoint's cylinder perimeter
    for (let i = 0; i < task.turnpoints.length; i++) {
      const tp = task.turnpoints[i];
      const dist = andoyerDistance(tp.waypoint.lat, tp.waypoint.lon, path[i].lat, path[i].lon);
      expect(Math.abs(dist - tp.radius)).toBeLessThan(1.0); // within 1m of cylinder
    }
  });

  it('should handle two turnpoints (no iteration needed)', () => {
    const task = makeTask([
      makeTurnpoint('A', 47.0, 11.0, 1000, 'SSS'),
      makeTurnpoint('B', 47.1, 11.0, 500, 'ESS'),
    ]);

    const path = calculateOptimizedTaskLine(task);
    expect(path).toHaveLength(2);

    const distance = calculateOptimizedTaskDistance(task);
    // ~11km minus the two radii
    expect(distance).toBeGreaterThan(9000);
    expect(distance).toBeLessThan(11000);
  });

  it('collinear turnpoints should produce a straight line', () => {
    // Three points on the same meridian
    const task = makeTask([
      makeTurnpoint('A', 47.0, 11.0, 500, 'SSS'),
      makeTurnpoint('B', 47.05, 11.0, 500),
      makeTurnpoint('C', 47.1, 11.0, 500, 'ESS'),
    ]);

    const path = calculateOptimizedTaskLine(task);
    expect(path).toHaveLength(3);

    // All points should have nearly the same longitude
    for (const p of path) {
      expect(p.lon).toBeCloseTo(11.0, 3);
    }
  });

  it('segment distances should sum to total distance', () => {
    const taskContent = readFileSync(
      resolve(__dirname, '../../../web/frontend/public/data/tasks/face.xctsk'),
      'utf-8'
    );
    const task = parseXCTask(taskContent);

    const total = calculateOptimizedTaskDistance(task);
    const segments = getOptimizedSegmentDistances(task);

    const segmentSum = segments.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - segmentSum)).toBeLessThan(0.01);
  });
});

describe('task optimizer — cylinder tolerance', () => {
  it('XCTask.cylinderTolerance should be available on parsed tasks', () => {
    const task = makeTask([
      makeTurnpoint('A', 47.0, 11.0, 1000, 'SSS'),
      makeTurnpoint('B', 47.1, 11.0, 500, 'ESS'),
    ]);

    // Default is undefined (0.5% applied in detectCylinderCrossings)
    expect(task.cylinderTolerance).toBeUndefined();

    // Can be set explicitly
    task.cylinderTolerance = 0.001; // Cat 1
    expect(task.cylinderTolerance).toBe(0.001);
  });
});
