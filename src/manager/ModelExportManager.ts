import type { DecodedModel } from "../common/DecodedModel.js";
import { GltfEncodeEngine } from "../engine/GltfEncodeEngine.js";

const GLTF_MIME_TYPE = "model/gltf+json";

/**
 * What {@link ModelExportManager.export} accepts. `format` is a literal
 * union of one member today — matching SPEC.md section 7a's public API
 * sketch, `export(model, { format: 'gltf' })` — so a caller already states
 * intent the same way they will once a second export format exists,
 * rather than that becoming a breaking signature change later.
 */
export interface ExportOptions {
  readonly format: "gltf";
}

/**
 * The whole public surface for export (SPEC.md section 3): serialise a
 * decoded model so the host can store it and skip re-parsing.
 *
 * Kept entirely separate from `ModelLoadManager` — no import between them
 * in either direction, and none should ever be added — because export is
 * a different workflow and Manager must never call Manager
 * (ARCHITECTURE.md section 2). `.dependency-cruiser.js`'s
 * `no-manager-to-manager` rule fails the build if that changes. See
 * REVIEW-BACKLOG.md for why the public surface is this class plus
 * `ModelLoader`, two small objects, rather than one `loader.export()`.
 */
export class ModelExportManager {
  constructor(
    private readonly gltfEncoder: GltfEncodeEngine = new GltfEncodeEngine(),
  ) {}

  // Not `async`: GltfEncodeEngine.transform() is synchronous, so there's
  // nothing to await. The `Promise<Blob>` return type matches SPEC.md
  // section 7a's public sketch (`await loader.export(...)`) — a caller
  // shouldn't have to know this happens to resolve immediately today, in
  // case a future export format needs a real await.
  export(model: DecodedModel, options: ExportOptions): Promise<Blob> {
    switch (options.format) {
      case "gltf":
        return Promise.resolve(
          new Blob([toBlobPart(this.gltfEncoder.transform(model))], {
            type: GLTF_MIME_TYPE,
          }),
        );
    }
  }
}

// TypeScript's typed arrays are generic over their backing buffer as of
// TS 5.7+. `GltfEncodeEngine.transform()`'s unparameterized `Uint8Array`
// return type — the same "just bytes" shape every other Engine/Accessor
// boundary in this codebase uses — widens to `Uint8Array<ArrayBufferLike>`,
// which `Blob`'s `BlobPart` type then rejects. Same gotcha `HashUtil.ts`'s
// `toArrayBuffer` and `node-fs.d.ts` already document; fixed the same way,
// by copying into a freshly allocated buffer that's always a real
// `ArrayBuffer`, never a `SharedArrayBuffer`.
function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
