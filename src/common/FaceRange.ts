/**
 * One original CAD face, as a contiguous run of triangle indices. Both
 * decoders produce this for free — OCCT returns a `brep_faces` mapping, and
 * the SolidWorks decoder knows its own strip boundaries — and it is what
 * makes face picking, per-face colour and measurement possible later.
 *
 * A `DecodedMesh`'s `faces` must exactly and contiguously cover its
 * `indices` with no gaps or overlaps: `toThree` (`src/three/index.ts`) turns
 * each one into a three.js geometry group, and `BufferGeometry` groups
 * silently drop or duplicate triangles when that invariant doesn't hold,
 * rather than erroring.
 */
export interface FaceRange {
  readonly id: number;
  /** First index, into the owning {@link DecodedMesh}'s `indices`. */
  readonly start: number;
  readonly count: number;
  /** sRGB, 0-1 per channel — see `toThree`'s `materialFor` in `src/three/index.ts`. */
  readonly color?: readonly [number, number, number];
}
