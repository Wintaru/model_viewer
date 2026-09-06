import type { DecodedModel } from "../common/DecodedModel";
import { WorkerTransport, type WorkerLike } from "../utility/WorkerTransport";

/**
 * What one `transform` call sends to `dxf.worker.ts`. Not shared by import
 * with that file — both live in `src/engine/`, and Engine must never call
 * Engine (ARCHITECTURE.md section 2) — so each side of this wire protocol
 * declares its own matching shape, the same reasoning `OcctDecodeRequest`
 * and `SolidWorksDecodeRequest` document.
 */
export interface DxfDecodeRequest {
  readonly bytes: Uint8Array;
}

/**
 * The main-thread half of the bridge ARCHITECTURE.md section 3 draws,
 * mirrored from `SolidWorksDecodeEngineProxy`: `ModelLoadManager ->
 * DxfDecodeEngineProxy -> WorkerTransport ==> DxfDecodeEngine`. Implements
 * the same `transform(bytes)` shape every other decoder exposes, so
 * `ModelLoadManager` can call whichever decoder a format resolves to
 * without knowing a worker is involved for this one.
 *
 * Like `SolidWorksDecodeEngineProxy`, there is no wasm asset and so no
 * per-instance configuration to accept — `createWorker` is the only
 * constructor parameter, and it has a real, parameterless default.
 *
 * The real worker is constructed lazily, on the first `transform` call,
 * and reused for every call after that — the same 1:1, whole-lifetime
 * pairing `WorkerTransport` expects.
 */
export class DxfDecodeEngineProxy {
  private transport:
    WorkerTransport<DxfDecodeRequest, DecodedModel> | undefined;

  constructor(
    // Injectable so tests substitute an in-process WorkerLike fake instead
    // of a real browser Worker.
    private readonly createWorker: () => WorkerLike = () =>
      new Worker(new URL("./dxf.worker.js", import.meta.url), {
        type: "module",
      }),
  ) {}

  transform(bytes: Uint8Array): Promise<DecodedModel> {
    return this.getTransport().request({ bytes }, [bytes.buffer]);
  }

  private getTransport(): WorkerTransport<DxfDecodeRequest, DecodedModel> {
    this.transport ??= new WorkerTransport(this.createWorker());
    return this.transport;
  }
}
