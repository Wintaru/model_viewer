import occtimportjs, {
  type OcctBrepFace,
  type OcctMesh,
  type OcctModule,
  type OcctNode,
} from "occt-import-js";
import type { WasmAssetAccessor } from "../accessor/WasmAssetAccessor.js";
import type { DecodedMesh } from "../common/DecodedMesh.js";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel.js";
import type { FaceRange } from "../common/FaceRange.js";
import type { SceneNode } from "../common/SceneNode.js";
import { looksLikeStepFile } from "../utility/AsciiUtil.js";

const TRIANGLE_INDEX_STRIDE = 3;

/**
 * Bytes to a {@link DecodedModel} through OCCT (`occt-import-js`), the WASM
 * build of OpenCascade — SPEC.md section 10 slice 2, ARCHITECTURE.md
 * section 3. Reads both STEP and IGES: the same wasm module backs both
 * readers, so one engine covers both rather than duplicating the
 * worker/proxy/registry wiring for a second, near-identical engine — see
 * `research/FINDINGS.md` for how IGES support was verified.
 *
 * Runs `occt-import-js` in-process, on whichever thread this is
 * constructed on — worker-side in production (`OcctDecodeEngineProxy` owns
 * getting it there, arriving in commit 5), directly under Vitest in this
 * file's own tests, against the real NIST STEP corpus and three real IGES
 * files. Sources its wasm bytes through an injected `WasmAssetAccessor`
 * rather than letting `occt-import-js` fetch or locate the asset itself.
 */
export class OcctDecodeEngine {
  private occtModule: Promise<OcctModule> | undefined;

  constructor(private readonly wasmAssets: WasmAssetAccessor) {}

  async transform(bytes: Uint8Array): Promise<DecodedModel> {
    const occt = await this.getOcctModule();
    const isStep = looksLikeStepFile(bytes);

    let result;
    try {
      result = isStep
        ? occt.ReadStepFile(bytes, null)
        : occt.ReadIgesFile(bytes, null);
    } catch (error) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "occt-read-failed",
        message: `OCCT could not read this file: ${describeError(error)}`,
      });
    }

    if (!result.success) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "occt-read-failed",
        message: "OCCT reported failure reading this file.",
      });
    }
    if (result.meshes.length === 0) {
      // ARCHITECTURE.md section 7: a success report with zero meshes is a
      // real, measured failure mode — silent success here would be the
      // worst outcome a viewer could have. For a STEP file this is
      // typically an AP242 file using a tessellated representation this
      // OCCT import path doesn't return (WAYFINDER.md decision D5). For
      // IGES, plenty of real files (research/FINDINGS.md: all three this
      // engine has been verified against) hold only wireframe entities —
      // points, lines, arcs — with no solid or surface for OCCT to mesh.
      return createEmptyDecodedModel({
        severity: "error",
        code: "occt-empty-result",
        message: isStep
          ? "OCCT reported success but returned no geometry — likely an AP242 file using a tessellated representation this version cannot read. See WAYFINDER.md decision D5."
          : "OCCT reported success but returned no geometry — likely an IGES file holding only wireframe entities (points, lines, arcs) with no solid or surface to mesh.",
      });
    }

    // A separate try/catch from the one around ReadStepFile above: this
    // one guards the conversion into this repo's own shapes, not OCCT's
    // read itself, so a surprise here (a mesh shape the corpus this
    // engine has been tested against never exercised) gets its own
    // diagnostic rather than being misattributed to OCCT's read failing,
    // or worse, escaping transform() as an uncaught exception.
    try {
      return {
        units: "mm",
        meshes: result.meshes.map(toDecodedMesh),
        tree: [toSceneNode(result.root)],
        metadata: {},
        diagnostics: [],
      };
    } catch (error) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "occt-conversion-failed",
        message: `OCCT reported success, but converting its result failed: ${describeError(error)}`,
      });
    }
  }

  /**
   * Instantiating occt-import-js compiles a 2.3 MB (brotli) wasm module —
   * expensive enough that re-running it for every file this engine decodes
   * would be a real, avoidable cost, not a rounding error. Memoized across
   * calls to `transform`, the same "import at most once" reasoning
   * `ModuleRegistry` applies to a decoder chunk. A failed load is not
   * cached past the call that saw it fail, so a transient problem fetching
   * the wasm bytes doesn't permanently break every later decode attempt on
   * this engine.
   *
   * Deliberately not folded into the per-file diagnostic handling in
   * `transform`: this is the engine's own setup failing, not something
   * about the file being decoded, so it rejects rather than returning a
   * `DecodedModel` that would misattribute the failure to the file.
   */
  private getOcctModule(): Promise<OcctModule> {
    this.occtModule ??= (async () => {
      const wasmBinary = await this.wasmAssets.read();
      return occtimportjs({ wasmBinary });
    })().catch((error: unknown) => {
      this.occtModule = undefined;
      throw error;
    });
    return this.occtModule;
  }
}

function toDecodedMesh(mesh: OcctMesh): DecodedMesh {
  return {
    positions: Float32Array.from(mesh.attributes.position.array),
    normals: Float32Array.from(mesh.attributes.normal.array),
    indices: Uint32Array.from(mesh.index.array),
    faces: mesh.brep_faces.map(toFaceRange),
    ...(mesh.name !== "" ? { name: mesh.name } : {}),
    ...(mesh.color !== undefined ? { color: mesh.color } : {}),
  };
}

function toFaceRange(face: OcctBrepFace, id: number): FaceRange {
  return {
    id,
    start: face.first * TRIANGLE_INDEX_STRIDE,
    count: (face.last - face.first + 1) * TRIANGLE_INDEX_STRIDE,
    ...(face.color !== null ? { color: face.color } : {}),
  };
}

function toSceneNode(node: OcctNode): SceneNode {
  return {
    ...(node.name !== "" ? { name: node.name } : {}),
    meshIndices: node.meshes,
    children: node.children.map(toSceneNode),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
