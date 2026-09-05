/**
 * One original CAD face, as a contiguous run of triangle indices. Both
 * decoders produce this for free — OCCT returns a `brep_faces` mapping, and
 * the SolidWorks decoder knows its own strip boundaries — and it is what
 * makes face picking, per-face colour and measurement possible later.
 */
export interface FaceRange {
  readonly id: number;
  /** First index, into the owning {@link DecodedMesh}'s `indices`. */
  readonly start: number;
  readonly count: number;
  readonly color?: readonly [number, number, number];
}
