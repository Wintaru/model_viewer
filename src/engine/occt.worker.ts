import { WasmAssetAccessor } from "../accessor/WasmAssetAccessor.js";
import type { DecodedModel } from "../common/DecodedModel.js";
import type {
  RequestEnvelope,
  ResponseEnvelope,
} from "../utility/WorkerTransport.js";
import { OcctDecodeEngine } from "./OcctDecodeEngine.js";

/**
 * The worker-side half of `OcctDecodeEngineProxy`'s bridge
 * (ARCHITECTURE.md section 3). Deliberately thin: a real `Worker` only
 * runs in a browser, so this file is wiring proven by the demo (SPEC.md
 * section 10 slice 2, commit 7), not a unit test — the logic it wires
 * together (`OcctDecodeEngine`, `WasmAssetAccessor`) already has its own
 * tests. See `OcctDecodeEngineProxy.ts`'s `OcctDecodeRequest` doc comment
 * for why this file declares its own matching request shape rather than
 * importing one — and `.dependency-cruiser.js`'s `no-engine-to-engine`
 * rule for why importing `OcctDecodeEngine` from here, unlike from
 * anywhere else in `src/engine/`, is allowed.
 */
interface OcctWorkerRequest {
  readonly bytes: Uint8Array;
  readonly wasmUrl: string;
}

// Constructing OcctDecodeEngine here, once, at module scope means the
// whole worker (a browser-only runtime, unavailable to Vitest) is what's
// thin and untested — the engine it wraps is already tested on its own.
let engine: OcctDecodeEngine | undefined;

function getEngine(wasmUrl: string): OcctDecodeEngine {
  engine ??= new OcctDecodeEngine(new WasmAssetAccessor(wasmUrl));
  return engine;
}

self.onmessage = (
  event: MessageEvent<RequestEnvelope<OcctWorkerRequest>>,
): void => {
  const { id, request } = event.data;
  getEngine(request.wasmUrl)
    .transform(request.bytes)
    .then((response) => postResponse({ id, ok: true, response }))
    .catch((error: unknown) =>
      postResponse({ id, ok: false, error: describeError(error) }),
    );
};

function postResponse(envelope: ResponseEnvelope<DecodedModel>): void {
  self.postMessage(envelope);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
