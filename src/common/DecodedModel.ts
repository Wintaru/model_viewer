import type { DecodedMesh } from "./DecodedMesh";
import type { Diagnostic } from "./Diagnostic";
import type { SceneNode } from "./SceneNode";

/**
 * The one thing every layer shares — renderer-agnostic by design. See
 * `SPEC.md` section 6.
 */
export interface DecodedModel {
  readonly units: "mm";
  readonly meshes: readonly DecodedMesh[];
  /** Assembly structure — see {@link SceneNode}. */
  readonly tree: readonly SceneNode[];
  readonly metadata: Readonly<Record<string, string>>;
  /** Embedded thumbnail, if present. */
  readonly preview?: Uint8Array;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A valid `DecodedModel` reporting that nothing could be decoded, carrying
 * exactly why — the same "never fail silently" shape `MeshDecodeEngine`
 * already needed, and every future decoder will too, so it lives here
 * rather than being rewritten in each one. The one exception to "Common:
 * types only, no runtime" (commit 5) is this factory: it holds no logic of
 * its own beyond constructing a value of the type right above it, the same
 * reasoning that colocates `fromBuffer` with `BufferSourceAccessor`. See
 * DECISIONS.md.
 */
export function createEmptyDecodedModel(diagnostic: Diagnostic): DecodedModel {
  return {
    units: "mm",
    meshes: [],
    tree: [],
    metadata: {},
    diagnostics: [diagnostic],
  };
}
