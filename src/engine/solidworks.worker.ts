import type { DecodedModel } from "../common/DecodedModel";
import type {
  RequestEnvelope,
  ResponseEnvelope,
} from "../utility/WorkerTransport";
import { SolidWorksDecodeEngine } from "./SolidWorksDecodeEngine";

/**
 * The worker-side half of `SolidWorksDecodeEngineProxy`'s bridge
 * (ARCHITECTURE.md section 3), mirrored from `occt.worker.ts`. Deliberately
 * thin: a real `Worker` only runs in a browser, so this file is wiring
 * proven by the demo (commit 7), not a unit test — the logic it wires
 * together (`SolidWorksDecodeEngine`) already has its own tests. See
 * `SolidWorksDecodeEngineProxy.ts`'s `SolidWorksDecodeRequest` doc comment
 * for why this file declares its own matching request shape rather than
 * importing one, and `.dependency-cruiser.js`'s
 * `solidworks-worker-only-imports-solidworks-engine` rule for why importing
 * `SolidWorksDecodeEngine` from here is allowed.
 *
 * Unlike `occt.worker.ts`, `SolidWorksDecodeEngine.transform` is
 * synchronous — no wasm module to await — so this wraps a plain call in a
 * try/catch rather than chaining `.then()`/`.catch()`.
 */
interface SolidWorksWorkerRequest {
  readonly bytes: Uint8Array;
}

// Constructed here, once, at module scope — the same reasoning
// occt.worker.ts documents for its own getEngine.
let engine: SolidWorksDecodeEngine | undefined;

function getEngine(): SolidWorksDecodeEngine {
  engine ??= new SolidWorksDecodeEngine();
  return engine;
}

self.onmessage = (
  event: MessageEvent<RequestEnvelope<SolidWorksWorkerRequest>>,
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
