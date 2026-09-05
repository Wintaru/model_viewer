export type { ModelSource } from "./accessor/ModelSource";
export { fromBuffer } from "./accessor/BufferSourceAccessor";
export { fromFile } from "./accessor/FileSourceAccessor";

/**
 * Re-exported under the friendlier public name SPEC.md section 7a's API
 * sketch gives it. `ModelLoadManager` is the internal name — it carries the
 * Manager-layer suffix the build-order table and ARCHITECTURE.md's layer map
 * use — but a caller of the published package has no reason to know iDesign
 * layer vocabulary. See REVIEW-BACKLOG.md, "the public loader is named two
 * ways".
 */
export { ModelLoadManager as ModelLoader } from "./manager/ModelLoadManager";
export type { ModelInput } from "./manager/ModelLoadManager";

export type {
  DecodedModel,
  DecodedMesh,
  Diagnostic,
  DiagnosticSeverity,
  FaceRange,
  FormatId,
  SceneNode,
} from "./common";
