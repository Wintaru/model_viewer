import type { FaceRange } from "./FaceRange";

/**
 * One mesh, in the units of the owning {@link DecodedModel}. `topology`
 * defaults to `'triangles'` when absent, so every 3D decoder written before
 * this field existed (OCCT, SolidWorks, STL) is unaffected.
 *
 * A `'lines'` mesh (added for DXF, WAYFINDER.md D6) pairs `indices` up
 * (`[0,1]`, `[2,3]`, …) instead of grouping them in triples, the same
 * convention `THREE.LineSegments` uses, and repurposes `name` to carry the
 * DXF layer name rather than a part name. `normals` is still required for a
 * `'lines'` mesh — filled with zeros, since a line has no meaningful normal
 * — to keep the type uniform rather than making every existing consumer
 * handle an optional field.
 *
 * **`toThree` (`src/three/index.ts`) assumes `'triangles'` and does not
 * check this field** — WAYFINDER.md's D6 was explicit that the three.js
 * adapter gains no 2D-only concepts, so feeding it a `'lines'` mesh is a
 * documented misuse, not a case it special-cases around. Render a `'lines'`
 * mesh through the `/2d` adapter instead.
 */
export interface DecodedMesh {
  /** xyz triples. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** CAD identity — see {@link FaceRange}. Always empty for `'lines'`. */
  readonly faces: readonly FaceRange[];
  /** A part name for `'triangles'`; the DXF layer name for `'lines'`. */
  readonly name?: string;
  /** sRGB, 0-1 per channel — see `toThree`'s `materialFor` in `src/three/index.ts`. */
  readonly color?: readonly [number, number, number];
  readonly topology?: "triangles" | "lines";
}
