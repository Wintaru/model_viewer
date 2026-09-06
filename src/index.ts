export type { ModelSource } from "./accessor/ModelSource";
export { fromBuffer } from "./accessor/BufferSourceAccessor";
export { fromFile } from "./accessor/FileSourceAccessor";
export { fromResponse } from "./accessor/ResponseSourceAccessor";
export { fromUrl, type UrlSourceInit } from "./accessor/UrlSourceAccessor";

/**
 * Re-exported under the friendlier public name SPEC.md section 7a's API
 * sketch gives it. `ModelLoadManager` is the internal name — it carries the
 * Manager-layer suffix the build-order table and ARCHITECTURE.md's layer map
 * use — but a caller of the published package has no reason to know iDesign
 * layer vocabulary. See REVIEW-BACKLOG.md, "the public loader is named two
 * ways".
 */
export { ModelLoadManager as ModelLoader } from "./manager/ModelLoadManager";
export type {
  ModelInput,
  SolidWorksDecoder,
  StepDecoder,
  StepDecoderConfig,
} from "./manager/ModelLoadManager";

/**
 * A second, separate object next to `ModelLoader` — not a `.export()`
 * method on `ModelLoader` itself. SPEC.md section 7a's public API sketch
 * shows one `loader` doing both; giving `ModelLoader` an `export()` would
 * mean `ModelLoadManager` importing `ModelExportManager`, exactly the
 * Manager-to-Manager edge `.dependency-cruiser.js`'s `no-manager-to-manager`
 * rule exists to fail the build on. See REVIEW-BACKLOG.md.
 */
export { ModelExportManager as ModelExporter } from "./manager/ModelExportManager";
export type { ExportOptions } from "./manager/ModelExportManager";

/**
 * Re-exported so a caller can build their own `StepDecoderConfig` — e.g.
 * to share one lazily-constructed OCCT worker across several `ModelLoader`
 * instances — without a deep import into `src/utility/`. The common case
 * (a bare wasm asset URL, per ARCHITECTURE.md section 4) needs neither
 * this nor `StepDecoder`/`StepDecoderConfig` above.
 */
export { ModuleRegistry } from "./utility/ModuleRegistry";

export type {
  DecodedModel,
  DecodedMesh,
  Diagnostic,
  DiagnosticSeverity,
  FaceRange,
  FormatId,
  SceneNode,
} from "./common";
