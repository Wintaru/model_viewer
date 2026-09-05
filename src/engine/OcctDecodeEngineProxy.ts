import type { DecodedModel } from "../common/DecodedModel";
import { WorkerTransport, type WorkerLike } from "../utility/WorkerTransport";

/**
 * What one `transform` call sends to `occt.worker.ts`. Not shared by
 * import with that file — both live in `src/engine/`, and Engine must
 * never call Engine (ARCHITECTURE.md section 2) — so each side of this
 * wire protocol declares its own matching shape. `postMessage` carries no
 * compiled type across the boundary anyway; only a runtime shape both
 * ends agree on by convention.
 */
export interface OcctDecodeRequest {
  readonly bytes: Uint8Array;
  /**
   * Expected constant for the lifetime of one proxy — resent with every
   * request rather than sent once at worker startup, because
   * `WorkerTransport` has no separate "init" concept and one more string
   * per request costs nothing.
   */
  readonly wasmUrl: string;
}

/**
 * The main-thread half of the bridge ARCHITECTURE.md section 3 draws:
 * `ModelLoadManager -> OcctDecodeEngineProxy -> WorkerTransport ==>
 * OcctDecodeEngine`. Implements the same `transform(bytes)` shape
 * `MeshDecodeEngine` and `OcctDecodeEngine` already expose, so
 * `ModelLoadManager` can call whichever decoder a format resolves to
 * without knowing a worker is involved for this one.
 *
 * The real worker (`occt.worker.ts`, this file's paired counterpart) is
 * constructed lazily, on the first `transform` call — a caller who never
 * opens a STEP file never spins one up — and reused for every call after
 * that, matching `WorkerTransport`'s own 1:1, whole-lifetime pairing with
 * one worker.
 *
 * Takes no default for `wasmUrl`, for the same reason `WasmAssetAccessor`
 * doesn't: no bundler is configured anywhere in this repository yet to
 * verify a guessed asset path against (see DECISIONS.md). Whatever wires
 * this proxy up (`ModelLoadManager`, arriving in commit 6) decides what to
 * pass.
 */
export class OcctDecodeEngineProxy {
  private transport:
    WorkerTransport<OcctDecodeRequest, DecodedModel> | undefined;

  constructor(
    private readonly wasmUrl: string,
    // Injectable so tests substitute an in-process WorkerLike fake instead
    // of a real browser Worker — the same strategy WorkerTransport.test.ts
    // already uses.
    private readonly createWorker: () => WorkerLike = () =>
      new Worker(new URL("./occt.worker.js", import.meta.url), {
        type: "module",
      }),
  ) {}

  transform(bytes: Uint8Array): Promise<DecodedModel> {
    return this.getTransport().request({ bytes, wasmUrl: this.wasmUrl }, [
      bytes.buffer,
    ]);
  }

  private getTransport(): WorkerTransport<OcctDecodeRequest, DecodedModel> {
    this.transport ??= new WorkerTransport(this.createWorker());
    return this.transport;
  }
}
