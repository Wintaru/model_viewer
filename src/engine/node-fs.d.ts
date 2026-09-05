/**
 * A minimal ambient declaration for the one Node builtin this repository's
 * tests need — reading a real fixture file from disk (`assets/step/*.stp`
 * for `OcctDecodeEngine.test.ts`, and `occt-import-js`'s own `.wasm`
 * binary from `node_modules`).
 *
 * Written by hand instead of adding `@types/node` as a dependency. This is
 * a browser-only library (CLAUDE.md, ARCHITECTURE.md), and `@types/node`
 * makes Node's ambient globals (`Buffer`, `process`, `require`,
 * `__dirname`, …) type-check successfully everywhere in `src/`, not just
 * in a test file that actually needs one — confirmed by hand during code
 * review of this same commit (a throwaway `Buffer.from(...)` reference in
 * an unrelated source file passed `tsc` and ESLint alike once `@types/node`
 * was added project-wide), which would have silently defeated the one
 * guard this toolchain has against a library source file accidentally
 * reaching for a Node-only API.
 *
 * Returns `Uint8Array<ArrayBuffer>`, not the real `Buffer` — a `Buffer` IS
 * one, but typing the return as the actual `Buffer` class needs
 * `@types/node`'s own ambient type. Every caller here only ever treats the
 * result as bytes. The `<ArrayBuffer>` parameter (TS 5.7+ typed arrays are
 * generic over their backing buffer) matters, not just style: without it
 * `.buffer` widens to `ArrayBufferLike` (`ArrayBuffer | SharedArrayBuffer`),
 * and `ArrayBuffer`-only APIs like `.slice()`'s return type reject the
 * union — the same gotcha `ModelLoadManager.test.ts`'s `binaryStl` helper
 * already documents. An ambient module declaration applies to the whole
 * compiled program once this file is included, not just to files in this
 * folder — colocated here because `OcctDecodeEngine.test.ts` is, for now,
 * its only user.
 */
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>;
}
