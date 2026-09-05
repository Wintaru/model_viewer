/**
 * The slice of the `fetch` surface {@link WasmAssetAccessor} needs — a
 * structural type rather than the global `fetch`'s full signature, so a
 * test can inject a minimal fake without a real network stack.
 */
export type FetchLike = (url: string | URL) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Fetches OCCT's `.wasm` binary as bytes, from a URL the caller supplies.
 * ARCHITECTURE.md section 4 draws this as an Accessor — `dec -->|"fetch
 * .wasm"| wasm` — returning bytes like every other Accessor's `read()`, not
 * a resolved URL string. `OcctDecodeEngine` passes those bytes to
 * `occt-import-js` as its `wasmBinary` option, which skips that library's
 * own environment-dependent `locateFile`/fetch machinery entirely — see
 * DECISIONS.md's slice-2 planning entry for why that's preferable to
 * letting occt-import-js fetch the asset itself.
 *
 * Deliberately has no computed default URL. `occt-import-js`'s `.wasm`
 * asset lives in `node_modules`, and there is no bundler configured
 * anywhere in this repository yet to verify a guessed relative path
 * against — inventing one now would be exactly the kind of unverified
 * claim this project's own conventions warn against. The caller supplies
 * the URL; ARCHITECTURE.md section 4 already anticipates this needing to
 * be documented per bundler (Vite, webpack, a plain script tag) once one
 * exists to test against.
 */
export class WasmAssetAccessor {
  constructor(
    private readonly url: string | URL,
    // A bare `fetch` reference, called later as `this.fetchImpl(...)`,
    // invokes the native function with the wrong receiver — browsers that
    // brand-check `fetch`'s `this` throw "Illegal invocation". Wrapping it
    // keeps the call inside a plain function, so `fetch` is always called
    // as itself regardless of how `fetchImpl` is later invoked.
    private readonly fetchImpl: FetchLike = (input) => fetch(input),
  ) {}

  async read(): Promise<Uint8Array> {
    const response = await this.fetchImpl(this.url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Failed to fetch the OCCT wasm binary from ${String(this.url)}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
