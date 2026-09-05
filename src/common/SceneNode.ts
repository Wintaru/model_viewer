/**
 * One node of the assembly tree. A single part decodes to one root
 * `SceneNode` with no children, pointing at its own mesh. Only parts are
 * verified (see CLAUDE.md); assemblies populate `children` and are untested.
 *
 * `transform` ships from v1, even though only the identity case is
 * exercised today — adding it once a real assembly decoder exists would
 * change the returned shape, which is a breaking change (see `faces` on
 * {@link DecodedMesh} for the same reasoning).
 */
export interface SceneNode {
  readonly name?: string;
  /** 4x4, column-major, in the same units as the owning {@link DecodedModel}. Identity if absent. */
  readonly transform?: Float32Array;
  /** Indices into the owning {@link DecodedModel}'s `meshes`. */
  readonly meshIndices: readonly number[];
  readonly children: readonly SceneNode[];
}
