import type { DiagnosticSeverity } from "./DiagnosticSeverity";

/**
 * A decoder's report of something a caller should know about, even when
 * decoding otherwise "succeeded". Exists because an AP242 tessellated STEP
 * file parses with no error and zero meshes — silent success is the worst
 * failure mode a viewer can have.
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable, machine-readable identifier — for callers that branch on it. */
  readonly code: string;
  readonly message: string;
}
