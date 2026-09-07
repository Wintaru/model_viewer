import { describe, expect, it } from "vitest";
import { tessellateArc } from "./ArcTessellationUtil.js";

describe("tessellateArc", () => {
  it("tessellates a full circle, closing the loop", () => {
    const points = tessellateArc(0, 0, 1, 0, 2 * Math.PI, 4);

    expect(points).toHaveLength(10); // (segments + 1) * 2
    expect(points[0]).toBeCloseTo(1, 5); // angle 0
    expect(points[1]).toBeCloseTo(0, 5);
    expect(points[2]).toBeCloseTo(0, 5); // angle pi/2
    expect(points[3]).toBeCloseTo(1, 5);
    expect(points[4]).toBeCloseTo(-1, 5); // angle pi
    expect(points[5]).toBeCloseTo(0, 5);
    expect(points[8]).toBeCloseTo(points[0] ?? NaN, 5); // closes: last ≈ first
    expect(points[9]).toBeCloseTo(points[1] ?? NaN, 5);
  });

  it("tessellates a partial arc to hand-computed points", () => {
    const points = tessellateArc(0, 0, 2, 0, Math.PI / 2, 2);

    expect(points[0]).toBeCloseTo(2, 5); // start: angle 0
    expect(points[1]).toBeCloseTo(0, 5);
    expect(points[2]).toBeCloseTo(Math.SQRT2, 5); // midpoint: angle pi/4
    expect(points[3]).toBeCloseTo(Math.SQRT2, 5);
    expect(points[4]).toBeCloseTo(0, 5); // end: angle pi/2
    expect(points[5]).toBeCloseTo(2, 5);
  });

  it("sweeps monotonically through an arc that wraps past 0/360 degrees", () => {
    // A DXF ARC from 350 deg to 10 deg sweeps counterclockwise through 360,
    // so the caller adds a full turn to endAngle (10 deg -> 370 deg) before
    // calling — this function only interpolates the angles it's handed.
    const startAngle = (350 * Math.PI) / 180;
    const endAngle = (370 * Math.PI) / 180;
    const points = tessellateArc(5, 5, 3, startAngle, endAngle, 2);

    // Midpoint lands exactly on 360 deg (0 deg): center + (radius, 0).
    expect(points[2]).toBeCloseTo(8, 5);
    expect(points[3]).toBeCloseTo(5, 5);
    // Start (350 deg) and end (370 deg = 10 deg) share the same x by
    // symmetry, but y moves from below center to above it — confirming the
    // sweep actually advanced through the wrap instead of reversing.
    expect(points[0]).toBeCloseTo(points[4] ?? NaN, 5);
    expect(points[1]).toBeLessThan(5);
    expect(points[5]).toBeGreaterThan(5);
  });

  it("returns exactly segments + 1 points", () => {
    const points = tessellateArc(0, 0, 1, 0, Math.PI, 7);

    expect(points).toHaveLength((7 + 1) * 2);
  });

  it("rejects a non-positive segment count", () => {
    expect(() => tessellateArc(0, 0, 1, 0, Math.PI, 0)).toThrow(RangeError);
    expect(() => tessellateArc(0, 0, 1, 0, Math.PI, -1)).toThrow(RangeError);
  });
});
