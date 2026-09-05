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
