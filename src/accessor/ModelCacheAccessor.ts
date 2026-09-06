import type { DecodedModel } from "../common/DecodedModel";

/**
 * Answers `Load` and `Store` for a previously decoded model —
 * ARCHITECTURE.md section 6a's exact semantic methods for this Accessor.
 * Public interface, host-implemented, same as `ModelSource`: the library
 * has no idea what storage a host has (IndexedDB, a file on disk, a remote
 * key-value store, …), so it must not assume one.
 *
 * The *policy* — check the cache, decode on a miss, store the result — is
 * orchestration and lives in `ModelLoadManager`. This Accessor only moves a
 * `DecodedModel` in and out of whatever storage the host chose; it holds no
 * logic of its own, same as every other Accessor.
 *
 * `key` is opaque here — the library computes it (ARCHITECTURE.md section
 * 6a: `hash(file bytes) + decoderName + decoderVersion + optionsHash`) and
 * the host stores by it, never derives or interprets it.
 */
export interface ModelCacheAccessor {
  /** A cache miss returns `undefined`, never throws. */
  load(key: string): Promise<DecodedModel | undefined>;

  /**
   * May reject. A failed store must not fail the load that produced
   * `model` — ARCHITECTURE.md section 6a treats the cache as disposable,
   * so the caller (`ModelLoadManager`) is expected to let the model
   * through regardless and only lose the caching benefit on this call.
   */
  store(key: string, model: DecodedModel): Promise<void>;
}
