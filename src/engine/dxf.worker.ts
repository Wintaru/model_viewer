import type { DecodedModel } from "../common/DecodedModel.js";
import type {
  RequestEnvelope,
  ResponseEnvelope,
} from "../utility/WorkerTransport.js";
import { DxfDecodeEngine } from "./DxfDecodeEngine.js";

/**
 * The worker-side half of `DxfDecodeEngineProxy`'s bridge (ARCHITECTURE.md
 * section 3), mirrored from `solidworks.worker.ts`. Deliberately thin: a
 * real `Worker` only runs in a browser, so this file is wiring proven by
 * the demo (commit 7), not a unit test — the logic it wires together
 * (`DxfDecodeEngine`) already has its own tests. See
 * `DxfDecodeEngineProxy.ts`'s `DxfDecodeRequest` doc comment for why this
 * file declares its own matching request shape rather than importing one,
 * and `.dependency-cruiser.js`'s `dxf-worker-only-imports-dxf-engine` rule
 * for why importing `DxfDecodeEngine` from here is allowed.
 *
 * Like `solidworks.worker.ts`, `DxfDecodeEngine.transform` is synchronous —
 * no wasm module to await — so this wraps a plain call in a try/catch
 * rather than chaining `.then()`/`.catch()`.
 */
interface DxfWorkerRequest {
  readonly bytes: Uint8Array;
}

// Constructed here, once, at module scope — the same reasoning
// occt.worker.ts documents for its own getEngine.
let engine: DxfDecodeEngine | undefined;

function getEngine(): DxfDecodeEngine {
  engine ??= new DxfDecodeEngine();
  return engine;
}

self.onmessage = (
  event: MessageEvent<RequestEnvelope<DxfWorkerRequest>>,
): void => {
  const { id, request } = event.data;
  try {
    const response = getEngine().transform(request.bytes);
    postResponse({ id, ok: true, response });
  } catch (error: unknown) {
    postResponse({ id, ok: false, error: describeError(error) });
  }
};

function postResponse(envelope: ResponseEnvelope<DecodedModel>): void {
  self.postMessage(envelope);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
