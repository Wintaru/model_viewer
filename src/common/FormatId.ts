/**
 * A CAD file format recognized from its bytes by `FormatSniffEngine`, and
 * used by `ModelLoadManager` to pick a decoder — genuinely cross-cutting
 * (produced by one Engine, consumed by Manager), so it lives in Common
 * rather than in `src/engine/` alongside its producer. See
 * `src/engine/FormatSniffEngine.ts` for what each id actually detects, and
 * for the formats deliberately not covered yet (every mesh format except
 * STL).
 */
export type FormatId = "step" | "iges" | "solidworks" | "stl" | "dxf";
