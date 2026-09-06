/**
 * Minimal ambient types for `occt-import-js` — it ships no `.d.ts` of its
 * own (checked `node_modules/occt-import-js`: package.json, JS and the
 * `.wasm` binary, nothing else). Declares `ReadStepFile` and `ReadIgesFile`,
 * and the result shape this repository has actually run and inspected
 * against real files: the NIST STEP corpus for `ReadStepFile`
 * (`research/probe-step.mjs`, re-confirmed field-by-field while building
 * `OcctDecodeEngine` — see DECISIONS.md's slice-2 commit-4 entry), and three
 * real IGES 5.3 files for `ReadIgesFile` (`research/FINDINGS.md`) —
 * confirmed to return the identical `OcctReadResult` shape.
 *
 * The package also exports `ReadBrepFile`. Deliberately not declared here,
 * for the same reason it stayed out until now for IGES: nothing in this
 * repository has ever run it or inspected its result shape, so typing it
 * now would be a guess, not a measurement.
 */
declare module "occt-import-js" {
  export interface OcctReadParams {
    readonly linearUnit?:
      "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    readonly linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    readonly linearDeflection?: number;
    readonly angularDeflection?: number;
  }

  export interface OcctBrepFace {
    /** First triangle index (not vertex index) belonging to this face. */
    readonly first: number;
    /** Last triangle index (inclusive) belonging to this face. */
    readonly last: number;
    /** sRGB, 0-1 per channel. `null`, not omitted, when the face has none. */
    readonly color: readonly [number, number, number] | null;
  }

  export interface OcctMesh {
    readonly name: string;
    /** sRGB, 0-1 per channel. Omitted, not `null`, when the mesh has none. */
    readonly color?: readonly [number, number, number];
    readonly brep_faces: readonly OcctBrepFace[];
    readonly attributes: {
      readonly position: { readonly array: readonly number[] };
      readonly normal: { readonly array: readonly number[] };
    };
    readonly index: { readonly array: readonly number[] };
  }

  export interface OcctNode {
    readonly name: string;
    /** Indices into the result's top-level `meshes` array. */
    readonly meshes: readonly number[];
    readonly children: readonly OcctNode[];
  }

  export interface OcctReadResult {
    readonly success: boolean;
    readonly root: OcctNode;
    readonly meshes: readonly OcctMesh[];
  }

  export interface OcctModule {
    ReadStepFile(
      content: Uint8Array,
      params: OcctReadParams | null,
    ): OcctReadResult;
    ReadIgesFile(
      content: Uint8Array,
      params: OcctReadParams | null,
    ): OcctReadResult;
  }

  export interface OcctModuleOptions {
    /**
     * The wasm binary, pre-fetched. Passing this skips occt-import-js's own
     * `locateFile`/environment-detection fetch path entirely — see
     * `WasmAssetAccessor`'s doc comment for why this repo always supplies
     * it rather than letting the library fetch its own asset.
     */
    readonly wasmBinary?: Uint8Array;
  }

  export default function occtimportjs(
    options?: OcctModuleOptions,
  ): Promise<OcctModule>;
}
