import type { FaceRange } from "./FaceRange";

/** One triangle mesh, in the units of the owning {@link DecodedModel}. */
export interface DecodedMesh {
  /** xyz triples. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** CAD identity — see {@link FaceRange}. */
  readonly faces: readonly FaceRange[];
  readonly name?: string;
  /** sRGB, 0-1 per channel — see `toThree`'s `materialFor` in `src/three/index.ts`. */
  readonly color?: readonly [number, number, number];
}
