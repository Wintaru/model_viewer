import type { DecodedModel } from "../common/DecodedModel.js";
import {
  WorkerTransport,
  type WorkerLike,
} from "../utility/WorkerTransport.js";

/**
 * What one `transform` call sends to `solidworks.worker.ts`. Not shared by
 * import with that file — both live in `src/engine/`, and Engine must
 * never call Engine (ARCHITECTURE.md section 2) — so each side of this
 * wire protocol declares its own matching shape, the same reasoning
 * `OcctDecodeRequest` documents.
 */
export interface SolidWorksDecodeRequest {
  readonly bytes: Uint8Array;
}

/**
 * The main-thread half of the bridge ARCHITECTURE.md section 3 draws,
 * mirrored from `OcctDecodeEngineProxy`: `ModelLoadManager ->
 * SolidWorksDecodeEngineProxy -> WorkerTransport ==>
 * SolidWorksDecodeEngine`. Implements the same `transform(bytes)` shape
 * every other decoder exposes, so `ModelLoadManager` can call whichever
 * decoder a format resolves to without knowing a worker is involved for
 * this one.
 *
 * Unlike `OcctDecodeEngineProxy`, there is no wasm asset and so no
 * per-instance configuration to accept — `createWorker` is the only
 * constructor parameter, and it has a real, parameterless default because
 * nothing here depends on a bundler-specific asset path the way
 * `WasmAssetAccessor` does.
 *
 * The real worker is constructed lazily, on the first `transform` call,
 * and reused for every call after that — the same 1:1, whole-lifetime
 * pairing `WorkerTransport` expects.
 */
export class SolidWorksDecodeEngineProxy {
  private transport:
    WorkerTransport<SolidWorksDecodeRequest, DecodedModel> | undefined;

  constructor(
    // Injectable so tests substitute an in-process WorkerLike fake instead
    // of a real browser Worker.
    private readonly createWorker: () => WorkerLike = () =>
      new Worker(new URL("./solidworks.worker.js", import.meta.url), {
        type: "module",
      }),
  ) {}

  transform(bytes: Uint8Array): Promise<DecodedModel> {
    return this.getTransport().request({ bytes }, [bytes.buffer]);
  }

  private getTransport(): WorkerTransport<
    SolidWorksDecodeRequest,
    DecodedModel
  > {
    this.transport ??= new WorkerTransport(this.createWorker());
    return this.transport;
  }
}
