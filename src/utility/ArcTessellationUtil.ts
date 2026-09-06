const MIN_SEGMENTS = 1;

/**
 * Tessellates a circular arc into a flat array of 2D points (`x0,y0,
 * x1,y1, …`) — open, from `startAngle` to `endAngle` inclusive: `segments +
 * 1` points connected by `segments` straight sub-segments. Angles are in
 * radians, walked with a strictly increasing linear interpolation from
 * `startAngle` to `endAngle`.
 *
 * Genuinely domain-free circle geometry — no knowledge of DXF, arcs versus
 * circles, or what "closed" means for either. Pulled out as its own Utility
 * so `DxfDecodeEngine` (a later commit) is a thin caller rather than
 * embedding this math, the same split ARCHITECTURE.md section 6 already
 * draws between container extraction and tessellation for SolidWorks.
 *
 * **Does not normalize a "wrapped" sweep.** A DXF `ARC` where `endAngle` is
 * numerically less than `startAngle` (it crosses 0°/360°) still sweeps
 * counterclockwise in the DXF format — the caller must add a full turn
 * (2π) to `endAngle` before calling, so the sweep this function walks is
 * always positive. This function only interpolates the angles it's given.
 *
 * **A full circle needs no separate "closed" handling.** Call with a sweep
 * of exactly 2π (`endAngle = startAngle + 2 * Math.PI`): the first and last
 * of the `segments + 1` points coincide to within floating-point precision,
 * closing the loop as a side effect of the sweep, not a special case.
 */
export function tessellateArc(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  segments: number,
): Float32Array {
  if (segments < MIN_SEGMENTS) {
    throw new RangeError(
      `tessellateArc needs at least ${MIN_SEGMENTS} segment(s), got ${segments}.`,
    );
  }
  const points = new Float32Array((segments + 1) * 2);
  const sweep = endAngle - startAngle;
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + sweep * (i / segments);
    points[i * 2] = centerX + radius * Math.cos(angle);
    points[i * 2 + 1] = centerY + radius * Math.sin(angle);
  }
  return points;
}
