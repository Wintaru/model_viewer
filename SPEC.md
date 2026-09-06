# Specification — browser CAD viewer library

Written 2026-09-04 12:27, from the decisions on the wayfinder map.
Every claim here traces to an entry in `DECISIONS.md`. Nothing is invented.

> Diagrams for all of this live in `ARCHITECTURE.md`.

## 1. What this is

An open-source npm library that renders engineering CAD files in a browser.
All conversion runs on the client. Version 1 opens:

| Family | Formats | Route |
| --- | --- | --- |
| Neutral CAD | STEP, IGES | `occt-import-js` (OCCT through WebAssembly) |
| SolidWorks | SLDPRT, SLDASM | Our own decoder, see `research/d9-decode.py` |
| Mesh | STL, OBJ, PLY, glTF, 3MF | three.js loaders |
| 2D drawings | DXF | `dxf-viewer` |

Out of v1: DWG (only a GPL reader exists), SLDDRW (no open path), PMI, and
Parasolid B-rep.

## 2. Volatility analysis

iDesign decomposes by what changes, not by what things do. For this library the
volatility falls out cleanly, which is why the layering below is not arbitrary.

**Volatile — expect these to change often**

- *Format decoders.* New formats get added. SolidWorks changes its container
  between releases; we have already seen two (2018 and 2020) and the decoder
  needs all four byte alignments to handle them.
- *Byte sources.* A file picker today, Supabase Storage tomorrow, something
  else after that.
- *Renderer.* three.js ships breaking changes. Another engine may appear.

**Stable — these should almost never change**

- The sequence: get bytes, identify format, decode, hand back a result.
- The neutral geometry model: positions, normals, indices, identity, metadata.

So decoders, sources and renderers are the volatile edges. The orchestration
and the geometry model are the stable core. Volatile things must not be able to
reach into the stable core, and the stable core must not know their names.

## 3. Layer map

```
Client    host application, demo page
   |
Manager   ModelLoadManager, ModelExportManager
   |                    \
Engine    decoders,      Accessor  source readers, WASM asset fetch
          format sniffer
   |                        |
Utility   worker transport, module registry, typed-array helpers,
          deflate helper, logging
```

The full allow/forbid table lives in `ARCHITECTURE.md` section 2 — that copy is
authoritative. `.dependency-cruiser.js` is its executable form: a
boundary-crossing import fails `depcruise src` instead of only living in prose.

### Client

The host application, and our demo page. Neither knows that OCCT or `dxf-viewer`
exist. Both call a Manager.

### Manager — orchestration, stable

- **`ModelLoadManager`** — the whole public surface for loading. Sequence:
  ask an Accessor for bytes, ask the sniffer Engine what the format is, resolve
  the decoder for that format, run it, assemble the result.
- **`ModelExportManager`** — serialise a decoded result so the host can store
  it and skip re-parsing. Separate Manager because export is a different
  workflow, and Manager must never call Manager. It calls `GltfEncodeEngine`,
  not the decoders.

### Engine — pure transformation, volatile

One decoder per format family. Each takes bytes and returns the neutral model.
No I/O of its own except through an Accessor.

- `FormatSniffEngine` — bytes to a format identifier. Pure.
- `GltfEncodeEngine` — a decoded model to glTF bytes. Export is not decoding
  run backwards, and Engine must never call Engine, so it is its own component.
- `OcctDecodeEngine` — STEP and IGES.
- `SolidWorksDecodeEngine` — SLDPRT and SLDASM.
- `MeshDecodeEngine` — STL, OBJ, PLY, glTF, 3MF.
- `DxfDecodeEngine` — DXF.

Engines never call each other. A format that needs two steps gets sequenced by
the Manager.

### Accessor — I/O boundaries, volatile

- `ModelCacheAccessor` — answers `Load` and `Store` for previously decoded
  models. Public interface, host-implemented, same as `ModelSource`. The policy
  (check, decode on miss, store) lives in `ModelLoadManager`; the key includes
  the decoder version, which only the library knows. See `ARCHITECTURE.md`
  section 6a.
- `BufferSourceAccessor`, `FileSourceAccessor`, `UrlSourceAccessor`,
  `ResponseSourceAccessor` — each answers `Load` with bytes. These are the only
  built-in sources. Their shared interface, `ModelSource`, is **public**, so a
  caller can supply their own. See section 7. There is no Supabase Accessor,
  and no Supabase dependency: a signed URL goes through `UrlSourceAccessor`
  like any other URL.
- `WasmAssetAccessor` — fetches the OCCT WebAssembly binary, with a
  caller-overridable URL.

Accessors never call each other and hold no logic.

### Utility — cross-cutting leaves

- `WorkerTransport` — moves a request to a Web Worker and back.
- `ModuleRegistry` — performs the lazy `import()` for a decoder.
- `TypedArrayUtil`, `InflateUtil`, `LogUtil`.

## 4. The Web Worker, and why it is a Utility

Decoding must not block the main thread. A 4.6 MB STEP file takes 8.4 seconds
in WebAssembly, so this is a requirement and not an optimisation.

The tempting model is to make the worker an Accessor. That breaks the call
graph, because the Manager would then call an Accessor which calls an Engine,
and Accessor-to-Engine is forbidden.

The correct model: the worker is **transport, not a layer**. Each Engine has a
thin main-thread proxy that implements the same interface and forwards over
`WorkerTransport`. The real implementation runs worker-side. The Manager still
calls an Engine, and the layering holds.

```
main thread                    worker
-----------                    ------
Manager
  -> OcctDecodeEngineProxy
       -> WorkerTransport  ==>  OcctDecodeEngine
                                  -> WasmAssetAccessor
```

## 5. Requests and responses

Every operation takes a typed request and returns a typed response, and each
layer owns its own contracts. Semantic methods only: Managers expose
`Execute` and `Query`, Engines expose `Transform`, Accessors expose `Load`.

Each layer implementation is a thin shell holding a `HandlerResolver`. All
logic lives in one handler per request type. Handlers are registered once, at
the composition root.

## 6. The neutral geometry model

This is the cross-cutting domain model, so it lives in `Common`. It is the one
thing every layer shares, and it is deliberately renderer-agnostic.

```ts
interface DecodedModel {
  readonly units: 'mm';
  readonly meshes: readonly DecodedMesh[];
  readonly tree: readonly SceneNode[];      // assembly structure
  readonly metadata: Readonly<Record<string, string>>;
  readonly preview?: Uint8Array;            // embedded thumbnail, if present
  readonly diagnostics: readonly Diagnostic[];
}

interface DecodedMesh {
  readonly positions: Float32Array;         // xyz triples
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly faces: readonly FaceRange[];     // CAD identity, see below
  readonly name?: string;
  readonly color?: readonly [number, number, number];
}

interface FaceRange {                       // one original CAD face
  readonly id: number;
  readonly start: number;                   // first index
  readonly count: number;
  readonly color?: readonly [number, number, number];
}
```

`faces` is the CAD identity decision. `occt-import-js` already returns a
`brep_faces` mapping, and our SolidWorks decoder produces per-strip structure.
Both are free at decode time. They are what make face picking, per-face colour
and measurement possible later, and adding them afterwards would change the
returned shape, which is a breaking change.

`diagnostics` exists because of a specific measured failure. An AP242
tessellated STEP file parses with `success: true` and zero meshes, so a naive
viewer shows an empty screen and reports success. Decoders must report that
rather than return nothing quietly.

## 7. Sources — the public Accessor contract

Sources are one of the three volatile edges (section 2), so the Accessor
interface is deliberately **public and open**. The library knows how to read
bytes. It does not know, and must never know, where bytes live.

Supabase is one example. It gets no special treatment and no dependency.

### The contract

```ts
/** Anything that can produce the bytes of a model file. */
export interface ModelSource {
  /** Filename, when known. A hint for format detection and diagnostics. */
  readonly name?: string;
  /** A strong identity from the storage layer, when one exists (an ETag or
   *  version id). Lets the cache be checked before the file is downloaded. */
  readonly etag?: string;
  /** Total size in bytes, when known. Enables progress reporting. */
  readonly byteLength?: number;

  /** Read the whole file. The only required method. */
  read(signal?: AbortSignal): Promise<Uint8Array>;

  /** Read part of the file, when the source can. See "sniff first" below. */
  readRange?(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;

  /** Stream the file, when the source can. Enables progress on large reads. */
  stream?(signal?: AbortSignal): ReadableStream<Uint8Array>;
}
```

`read` is the whole required surface. Every decoder in v1 needs the complete
buffer anyway: OCCT takes the full file, our SolidWorks decoder scans the whole
container for nested streams, and the DXF parser buffers before parsing. The
other two methods are capabilities, not requirements.

### Built-in sources

```ts
fromBuffer(bytes: ArrayBuffer | Uint8Array, name?: string): ModelSource;
fromFile(file: File | Blob, name?: string): ModelSource;
fromUrl(url: string | URL, init?: UrlSourceInit): ModelSource;
fromResponse(response: Response, name?: string): ModelSource;

interface UrlSourceInit {
  /** Inject authentication, retry, or a proxy. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
  readonly name?: string;
}
```

This is where `fetch` belongs, and it is now clearly scoped: a narrow knob on
the built-in URL source, not the general extension mechanism. It exists so a
caller can attach an `Authorization` header without us ever holding a token.

### Anything else: implement the interface

```ts
// Supabase Storage — no library dependency, just a signed URL.
const { data } = await supabase.storage.from('cad').createSignedUrl(path, 60);
await loader.load(fromUrl(data.signedUrl, { name: path }));

// S3 or Azure Blob presigned URLs work identically.

// A document system behind a bearer token.
await loader.load(fromUrl(docUrl, {
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...init?.headers, Authorization: bearer } }),
}));

// Something with no URL at all: Electron, OPFS, IndexedDB, a tar member.
class OpfsSource implements ModelSource {
  readonly name: string;
  // Assign in the constructor body from the parameter. A field initialiser
  // reading `this.handle` would run before the parameter property is set.
  constructor(private readonly handle: FileSystemFileHandle) {
    this.name = handle.name;
  }
  async read(): Promise<Uint8Array> {
    const file = await this.handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }
}
await loader.load(new OpfsSource(handle));
```

### Convenience input

The simple cases stay simple. `load` accepts a shorthand and normalises it to a
`ModelSource` internally.

```ts
export type ModelInput =
  | ModelSource
  | File | Blob
  | ArrayBuffer | Uint8Array
  | string | URL;
```

### Sniff first, when the source allows it

A source that implements `readRange` unlocks a real speed win. The loader reads
a small prefix, identifies the format from magic bytes, and starts the lazy
decoder import **in parallel** with the full download.

That matters because the OCCT decoder is 2.3 MB brotli. Fetching 2.3 MB of
WebAssembly and a large STEP file at the same time, rather than one after the
other, removes a whole round trip from first paint.

Without `readRange` the loader falls back to reading everything, then sniffing.
Same result, one less optimisation.

## 7a. Public API sketch

```ts
import { ModelLoader, fromUrl } from '@wintaru/part-viewer';
import { toThree } from '@wintaru/part-viewer/three';

const loader = new ModelLoader();

const model = await loader.load(file);                    // shorthand
const model = await loader.load(fromUrl(signedUrl));      // any remote store
const model = await loader.load(new MyCustomSource());    // anything at all

scene.add(toThree(model));

const blob = await loader.export(model, { format: 'gltf' });
```

Two points this encodes:

- The caller never names a format. `ModelLoadManager` sniffs and dispatches, and
  `ModuleRegistry` lazily imports only the decoder needed.
- `toThree` is a **separate entry point**, so a caller doing headless work, such
  as thumbnails or measurement, never pulls in three.js.

## 8. Packaging

One package, with the decoders behind dynamic `import()`.

The reason is measured, not assumed. On this machine
`occt-import-js.wasm` is 7.6 MB raw, **3.1 MB gzip and 2.3 MB brotli**.
`dxf-viewer` is about 790 KB unpacked. Mesh formats are nearly free. A single
bundle would charge every consumer roughly 3 MB before anything appeared, which
for a library other people embed is disqualifying.

Entry points:

```
@wintaru/part-viewer          core: loader, sniffer, neutral model
@wintaru/part-viewer/three    three.js adapter
```

The accepted cost is bundler sensitivity: a `.wasm` asset has to be emitted and
served rather than inlined. This must be documented for Vite, for webpack, and
for a plain script tag, and `WasmAssetAccessor` must let the caller override the
URL.

## 9. Enforcing the boundaries

The call graph above is the source of truth and needs a guard, or it drifts and
still compiles. Add `eslint-plugin-boundaries` or `dependency-cruiser` with the
layer rules encoded, so a Client that reaches past a Manager, or an Accessor
that imports an Engine, fails the build.

## 10. Build order

Each slice is independently shippable.

1. **Core plus mesh formats.** Neutral model, `ModelLoadManager`,
   `FormatSniffEngine`, buffer and file Accessors, `MeshDecodeEngine`, the
   three adapter. Smallest useful library, and it proves the shape.

   Broken down to commits. Each row's "leaves green" claim was checked by
   running the tool, not by assuming — four earlier rows were wrong.

   | # | Commit | Leaves green because |
   | --- | --- | --- |
   | 1 | `tsconfig.json`, `src/index.ts` (`export {}`), package scripts | **`src/index.ts` is required here.** `tsc` exits 2 with TS18003 when `include: ["src"]` matches nothing, and git cannot track an empty directory, so a placeholder entry point is the only way commit 1 is green after a fresh clone. |
   | 2 | ESLint + Prettier config **and `.prettierignore`** | `prettier --check .` fails on 13 tracked files without it. Generated artifacts (`demo/viewer.html`, `demo/nist-ctc-01.json`, `research/d8-truth.json`) must be ignored, or a reformatted copy stops matching a regenerated one and the audit trail breaks. Markdown is excluded too: these documents are hand-wrapped deliberately. |
   | 3 | `dependency-cruiser` layer rules | `src/` exists from commit 1, so `depcruise src` resolves. Rules must classify `Common`, or the guard passes vacuously over the one module every layer imports. |
   | 4 | Vitest config + one smoke test | the smoke test passes |
   | 5 | `Common`: `DecodedModel` and friends | types only, no runtime |
   | 6 | `Accessor`: `ModelSource` interface | interface only |
   | 7 | `Accessor`: `fromBuffer` + tests | tests ship with the code |
   | 8 | `Accessor`: `fromFile` + tests | same |
   | 9 | `Engine`: `FormatSniffEngine` + tests | same |
   | 10 | `Engine`: `MeshDecodeEngine`, **STL parsed by hand** + tests | no `three` dependency — see below |
   | 11 | `Manager`: `ModelLoadManager` + tests | calls Engines **directly**; `ModuleRegistry`, `WorkerTransport` and the Engine proxies arrive in slice 2 |
   | 12 | Build tooling + `exports` map | needed before a second entry point can exist |
   | 13 | three.js adapter at `/three` (adds the `three` dependency) | consumes the neutral model |
   | 14 | Library demo, **added beside the existing one** | see below |

   **Why STL is parsed by hand.** Routing mesh formats through three.js loaders
   would make an Engine depend on the renderer, and the renderer is one of the
   three volatile edges this architecture exists to isolate (section 2). Binary
   STL is a fixed 50-byte record; parsing it directly is smaller than the
   dependency. `three` enters the package only at commit 13, in the adapter.

   **Why the demo is added, not replaced.** `demo/viewer.html` and its
   screenshots are the committed evidence for the SolidWorks claim, and they
   come from the Python path. Slice 1 decodes STL only, so replacing the demo
   here would leave the repository showing a 3DBenchy and no SolidWorks proof at
   all. Retire the Python path in slice 3, once the TypeScript decoder
   reproduces `demo/nist-ctc-01.json` byte for byte — which is a useful port
   test in its own right.

   **Commit 14 is a smoke demo, not the designed viewer.** It proves the library
   loads a file end to end. The viewer's actual shape is decision D7, still open.

2. **STEP and IGES.** `OcctDecodeEngine` behind the worker proxy, plus
   `WasmAssetAccessor` and the lazy import. Proves the packaging decision.

   Broken down to commits, same reasoning as slice 1: each row's "leaves
   green" claim is what makes the plan checkable rather than just listed.

   | # | Commit | Leaves green because |
   | --- | --- | --- |
   | 1 | `Utility`: `ModuleRegistry` + tests | generic lazy `import()` cache keyed by a caller-supplied string type; takes no dependency on `Common` or any other layer, so it stays a leaf |
   | 2 | `Utility`: `WorkerTransport` + tests | generic request/response correlation over an injectable postMessage-shaped object; tests supply an in-process fake, no real browser `Worker` needed |
   | 3 | `Accessor`: `WasmAssetAccessor` + tests | fetches the OCCT `.wasm` binary as bytes from an overridable URL; tests inject a fake `fetch` |
   | 4 | `Engine`: `OcctDecodeEngine` + tests | runs `occt-import-js` in-process against the NIST STEP corpus (same approach as `research/probe-step.mjs`), sourcing its wasm bytes through a test double of `WasmAssetAccessor` that reads the real `.wasm` file from disk — so the test exercises the actual `wasmBinary` handoff, not a different path. **STEP only.** IGES is deferred: no IGES file exists anywhere in this repository (checked `scripts/fetch-assets.sh` — the NIST corpus is STEP and SLDPRT only), so there is nothing to verify a decode against. Same reasoning already recorded in `REVIEW-BACKLOG.md` for why `FormatSniffEngine` doesn't detect IGES yet — the two gaps are coupled and should close together. |
   | 5 | `Engine`: `OcctDecodeEngineProxy` + its paired worker entry point + tests | the proxy implements the same `transform(bytes)` shape `MeshDecodeEngine` already established, and is tested against an injected fake worker verifying the message contract and error propagation. The worker entry point itself is thin wiring — real `Worker` construction, pointed at the file via `new URL(..., import.meta.url)` — and is proven by the demo (row 7) rather than a unit test, the same split slice 1 drew between `MeshDecodeEngine`'s logic and its demo. |
   | 6 | `Manager`: wire `'step'` through `ModuleRegistry` into `ModelLoadManager` + tests | replaces the `unsupported-format` fallback for `'step'` with a lazy `import()` of the proxy module. `'stl'` dispatch is left exactly as it is — eager, direct, no registry — logged in `REVIEW-BACKLOG.md` as a follow-up rather than fixed here, to keep this commit to the one concern slice 2 is actually about |
   | 7 | Demo: extend `library-demo` to load a STEP file end to end | proves the packaging decision for real: a `.wasm` chunk fetched lazily, decoded off the main thread, in a browser |

   **Why `ModuleRegistry` and `WorkerTransport` arrive together, ahead of the
   engine that needs them.** Both are named, designed Utility components in
   `ARCHITECTURE.md` sections 2 and 3 already — not new invention — and
   `ModelLoadManager`'s own commit-11 comment says they "arrive in slice 2."
   Building them first, generic and dependency-free, means `OcctDecodeEngine`
   and its proxy are written against a settled contract instead of one
   improvised alongside them.

   **Why `WasmAssetAccessor` fetches bytes, not just a URL.**
   `ARCHITECTURE.md`'s diagram draws the edge as `dec -->|"fetch .wasm"| wasm`
   — an Accessor that hands back bytes, matching every other Accessor's
   `read()` shape, not a resolver that hands back a string. Passing those
   bytes to `occt-import-js` as `wasmBinary` sidesteps its own
   environment-dependent `locateFile`/fetch machinery entirely, which is the
   part sensitive to bundler configuration that section 4 already calls out
   as "the cost we accepted."

   **Why dispatch doesn't retrofit `'stl'` onto `ModuleRegistry` too.**
   Section 4's bundle diagram draws every format behind a dynamic import,
   `'stl'` included — so slice 1's direct, eager construction of
   `MeshDecodeEngine` is a known simplification, not the final shape. Slice 2
   is scoped to STEP and IGES; widening this commit to also change how mesh
   dispatch works would mix two concerns for no reader's benefit. Logged in
   `REVIEW-BACKLOG.md` instead.

   Later slices get the same treatment when they are reached. Do not break
   them down in advance: the plan will be wrong by the time you get there.
3. **SolidWorks.** Port `research/d9-decode.py` to TypeScript. Parts first,
   then assemblies, which are untested.

   Broken down to commits, same discipline as slices 1 and 2: each row's
   "leaves green" claim is what makes the plan checkable rather than just
   listed. Scoped to **parts only** — SLDASM stays out of this slice, matching
   WAYFINDER.md's D9 follow-up that only parts are proven.

   | # | Commit | Leaves green because |
   | --- | --- | --- |
   | 1 | `Utility`: `InflateUtil` (new `pako` dependency) + tests | a generic zlib-wrapped and raw-deflate inflate-at-offset, capped at a caller-supplied output size, built only on `pako`'s public `Inflate` class (`push`, `onData`, the `raw` option) — no private fields, no `as` past its types. Takes no dependency on `Common` or any other layer, so it stays a leaf. Tests cover a successful zlib decode, a successful raw decode, garbage rejected without throwing, and the cap actually aborting a bomb mid-stream rather than fully inflating it first. |
   | 2 | `Engine`: `SolidWorksDecodeEngine` — recursive stream extraction + tests | ports `collect`/`inflate_all` from `research/d9-decode.py`: scans every offset of a buffer through `InflateUtil` for a zlib or raw-deflate stream, recurses into each hit up to depth 5 under one aggregate decompression budget, and keeps only streams containing the `TessData` magic. Deduplicates by direct byte comparison, not `hash()` — closing the collision risk REVIEW-BACKLOG.md already logged against the Python original, without adding a hashing dependency to fix it. Tested against a real NIST SLDPRT file's raw bytes (`assets/solidworks/`, `pnpm assets`), asserting the same stream count `research/d9-decode.py` prints for it. |
   | 3 | `Engine`: `SolidWorksDecodeEngine` — tessellation block decode + tests | ports `decode_stream`/`_scan`: given one extracted stream, scans all 4 byte alignments for the `4, 8, 2, N` header (ARCHITECTURE.md section 6), reconstructs triangle **strips**, not fans, and discards candidates that overlap a larger one found at another alignment. Tested directly against one real extracted `TessData` stream, asserting the same vertex and triangle counts `research/d9-decode.py` prints for it. |
   | 4 | `Engine`: `SolidWorksDecodeEngine` — `transform()` assembling a `DecodedModel` + tests | wires extraction and block decode together, converts SolidWorks's own metres (FINDINGS.md section 5) to `DecodedModel`'s millimetres, and reports a `no-tessdata-found` diagnostic rather than an empty model when nothing decodes — the same honest-failure posture `OcctDecodeEngine` already takes. Verified against the full NIST corpus with the same check `research/d9-verify-cached.py` runs: reproduces the independently-measured STEP bounding box within 2 percent or 0.5mm for 6 of 11 parts. |
   | 5 | `Engine`: `SolidWorksDecodeEngineProxy` + its paired `solidworks.worker.ts` + tests | the same shape slice 2 commit 5 established: `transform(bytes): Promise<DecodedModel>`, forwarding over `WorkerTransport` to `SolidWorksDecodeEngine` running worker-side, tested against an injected fake worker the same way `OcctDecodeEngineProxy.test.ts` already is. Unlike `OcctDecodeEngineProxy`, there is no wasm asset to inject — the worker constructs `new SolidWorksDecodeEngine()` directly. |
   | 6 | `Manager`: wire `'solidworks'` through `ModuleRegistry` into `ModelLoadManager` + tests | replaces the `unsupported-format` fallback for `'solidworks'` (already sniffed since slice 1 commit 9) with a lazy `import()` of the proxy, the same shape `'step'` got in slice 2 commit 6. Unlike `'step'`, the real registry needs no caller-supplied URL — there is no wasm asset — so it gets a real, parameterless default; a caller only overrides it in tests. |
   | 7 | Demo: extend `library-demo` to load a real SLDPRT file end to end | proves the slice for real: a small NIST part, committed to `demo/` on the same precedent as `demo/nist-ftc-11.stp`, decoded off the main thread and added to the scene beside the existing STL cube and STEP part. |

   **Why `pako`, and why this slice takes a new runtime dependency where
   slice 2 did not.** The container-scan in commit 2 has no signature to
   pre-filter raw-deflate candidates on — `research/scan-deflate.py`'s own
   docstring calls this "attempt an inflate at every byte offset" — so it
   must run a cheap, synchronous decompression attempt at (up to) every
   offset in the file. The browser's native `DecompressionStream` is
   async and stream-based; paying a Promise per offset over a file with
   hundreds of thousands of candidate offsets would make the scan
   impractically slow. `pako` is a mature, dependency-free port of zlib
   with a synchronous, incremental API that exposes what this needs
   (`push`/`onData`/`raw`) without reaching past its public surface.

   **Why the outer scan does not chase exact consumed-byte counts.**
   `research/d9-decode.py`'s `_scan` (commit 3's concern, operating on one
   already-extracted stream) tracks exact byte spans to discard candidates
   that overlap a larger one — that still applies here. But the outer
   container scan's own dedup (Python's `collect`) happens by content
   afterward, not by position, so knowing precisely how many compressed
   bytes a hit consumed is a scan-speed nicety, not a correctness
   requirement. Deferred until a real NIST file's measured timing says it
   is needed, rather than built for a hypothetical — this repo's own
   working method (DECISIONS.md is full of "measured by hand" entries).

   **Why `'solidworks'` gets the lazy-worker treatment from commit 5,
   unlike `'stl'`.** REVIEW-BACKLOG.md already logs `'stl'`'s eager,
   non-worker dispatch as a known simplification against
   ARCHITECTURE.md section 4's target shape, not the model to copy. Slice
   2 built `'step'` the target way from its first commit; SolidWorks,
   being new work rather than a retrofit, does the same.

4. **Remote sources.** `UrlSourceAccessor` and `ResponseSourceAccessor`, plus
   the optional `readRange` path that lets the loader sniff a prefix and fetch
   the decoder in parallel with the download.

   Broken down to commits, same discipline as slices 1 to 3: each row's
   "leaves green" claim is what makes the plan checkable rather than just
   listed.

   | # | Commit | Leaves green because |
   | --- | --- | --- |
   | 1 | `Accessor`: `ResponseSourceAccessor` + `fromResponse` + tests | wraps a `Response` the host already obtained (SPEC.md section 7); same scope as `FileSourceAccessor` — `read()` only, no `readRange`/`stream` — because the request that produced the `Response` already went out with no Range header by the time this constructor runs, so there is no smaller request left to make |
   | 2 | `Accessor`: `UrlSourceAccessor` + `fromUrl`, `read()` only + tests | injectable `fetch`/`headers`/`name` (`UrlSourceInit`, SPEC.md section 7), the same injectable-fetch pattern `WasmAssetAccessor` already established, with the same default-`fetch`-binding fix (REVIEW-BACKLOG.md, slice-2 planning entry) applied from the start rather than found by a second review pass |
   | 3 | `Accessor`: `UrlSourceAccessor` — add `readRange` via an HTTP `Range` request + tests | issues a `Range: bytes=start-end` request over the same injected `fetch`; falls back to slicing the response locally when a server answers `200` instead of `206` (a proxy or CDN that strips `Range` rather than honoring it), so the contract holds either way |
   | 4 | `Manager`: widen `ModelInput` to accept `string \| URL`, routed through `fromUrl`, and wire the sniff-first fast path into `ModelLoadManager.load()` + tests | closes the gap `ModelLoadManager.ts`'s own `ModelInput` comment already flagged ("widen this type when [fromUrl] does exist"); when the resolved source implements `readRange`, `load()` reads a small prefix, sniffs it, and starts resolving the matching lazy decoder before the full download finishes, so the import and the rest of the transfer overlap instead of running back to back (ARCHITECTURE.md section 3) — a source with no `readRange` falls back to exactly the existing whole-file-then-sniff behaviour, unchanged |
   | 5 | Demo: `library-demo` loads the STEP and SolidWorks files through `fromUrl` instead of a manual `fetch` + `fromBuffer` | proves the packaging decision for real, over a real HTTP request in a browser, and exercises the sniff-first path this slice adds instead of only a fake `ModelSource` under Vitest |

   **Why `ResponseSourceAccessor` comes before `UrlSourceAccessor`.** Simpler
   scope first, the same ordering slice 1 used for `BufferSourceAccessor`
   before `FileSourceAccessor`: no network, no injectable `fetch`, no
   `readRange` — just wrapping a `Response` the host already has.

   **Why `UrlSourceAccessor`'s `read()` and its `readRange` are separate
   commits.** `FileSourceAccessor`'s own doc comment already deferred
   `readRange` out of slice 1 commit 8 for the same reason: each capability
   `ModelSource` makes optional earns its own decision about whether the
   payoff is worth the complexity, rather than being designed alongside
   `read()` on the assumption that it obviously belongs there too.

   **Why the sniff-first path reads a 4096-byte prefix.** Matches
   ARCHITECTURE.md section 3's sequence diagram (`readRange(0, 4096)`)
   exactly, rather than picking a new number — that diagram was already
   checked against `FormatSniffEngine`'s signatures (all within the first
   few dozen bytes) when it was drawn.
5. **Export and cache.** `ModelExportManager` with glTF out, plus
   `ModelCacheAccessor` and the key derivation.

   Broken down to commits, same discipline as slices 1 to 4: each row's
   "leaves green" claim is what makes the plan checkable rather than just
   listed.

   | # | Commit | Leaves green because |
   | --- | --- | --- |
   | 1 | `Utility`: `HashUtil` + tests | a generic SHA-256 digest of bytes over the Web Crypto API (`crypto.subtle.digest`), returned as lowercase hex — ARCHITECTURE.md section 6a's `cacheKey = hash(file bytes) + …`. Takes no dependency on `Common` or any other layer, so it stays a leaf. Tests cover known SHA-256 vectors (empty input, `"abc"`), that identical bytes hash identically, and that a single changed byte changes the digest. |
   | 2 | `Accessor`: `ModelCacheAccessor` interface | interface only, same shape as slice 1 commit 6's `ModelSource` — `Load` and `Store`, ARCHITECTURE.md section 6a's exact semantic methods, public and host-implemented since the library has no idea what storage a host has |
   | 3 | `Engine`: `GltfEncodeEngine` + tests | a decoded model to glTF bytes (SPEC.md section 3): `transform(model): Uint8Array`, pure and synchronous like `FormatSniffEngine`, no I/O of its own. Emits a single-file, embedded glTF 2.0 document (one `buffer` holding every mesh's positions/normals/indices, referenced by a base64 `data:` URI) rather than a binary `.glb` — simpler to construct and to verify byte-for-byte in a test, at the cost of a larger export than a packed binary would produce. **Scope: geometry and the node tree only** — no materials, vertex colors, metadata or embedded preview in this pass; `DecodedMesh.color`/`FaceRange.color` and `DecodedModel.metadata`/`preview` go unexported for now, logged in REVIEW-BACKLOG.md the same way slice 1 deferred OBJ/PLY/glTF/3MF. Tested against a small hand-built `DecodedModel` (two one-triangle meshes, a two-node tree with one translated child): asserts the emitted JSON's accessor counts, `min`/`max` bounds and `bufferView` byte math are correct, and that decoding the base64 buffer back reproduces the exact input `positions`/`normals`/`indices` bytes. |
   | 4 | `Manager`: `ModelExportManager` + tests | the whole public surface for export (SPEC.md section 3): `export(model, { format: 'gltf' }): Promise<Blob>`, wrapping `GltfEncodeEngine`'s bytes in a `Blob` (`model/gltf+json`) for host convenience — the same shell-plus-injected-engine shape `ModelLoadManager` already uses for `sniffer`/`meshDecoder`. Kept out of `ModelLoadManager` entirely — no import between them in either direction — because Manager must never call Manager. |
   | 5 | `Client`: export `ModelExportManager` from `src/index.ts`, as `ModelExporter` | same renaming precedent as slice 1 commit 12's `ModelLoadManager` → `ModelLoader` — a caller has no reason to know iDesign layer vocabulary. **Resolves a real gap in SPEC.md section 7a's sketch**, which shows one `loader` object exposing both `.load()` and `.export()`: giving `ModelLoader` an `export()` method would mean `ModelLoadManager` importing `ModelExportManager`, exactly the Manager-to-Manager edge `.dependency-cruiser.js`'s `no-manager-to-manager` rule exists to fail the build on. The real public surface is two small objects — `new ModelLoader()` and `new ModelExporter()` — not one. Logged in REVIEW-BACKLOG.md; SPEC.md section 7a's code sample is stale on this one line the same way it was already known to drift elsewhere. |
   | 6 | `Manager`: wire `ModelCacheAccessor` and a per-format decoder-version table into `ModelLoadManager.load()` + tests | the check-then-decode-then-store policy ARCHITECTURE.md section 6a assigns to `ModelLoadManager`: `cacheKey = hash(bytes) + format + decoderVersion` (`HashUtil`, commit 1), checked before decoding and stored after a miss, when a `ModelCacheAccessor` is supplied. `decoderVersion` comes from a small, manually-maintained `DECODER_VERSIONS` map, not a derived value — ARCHITECTURE.md's own justification for including it at all is that a decode-logic fix (SolidWorks's 3-of-11-to-6-of-11 jump) must invalidate every prior cache entry, which only a human bumping a constant when that logic changes can guarantee. No `optionsHash` term: `load()` takes no options parameter to hash, and adding one speculatively would be building for a requirement that doesn't exist yet. Tests inject a fake in-memory cache and a call-counting fake decoder, asserting a second `load()` of identical bytes returns the cached model without invoking the decoder again, and that bumping the version constant changes the key. |
   | 7 | Demo: extend `library-demo` to export and cache | loads the STL cube twice through an in-memory `ModelCacheAccessor` to show the second load skip decoding, then exports one loaded model through `ModelExporter` and offers the result for download — proves the slice end to end in a real browser, the same treatment every prior slice's final commit gives its own new surface. |

   **Why geometry first, everything else deferred, for `GltfEncodeEngine`.**
   Materials, per-face color and embedded metadata are all real v1-listed
   capabilities (`DecodedMesh.color`, `DecodedModel.metadata`), but none of
   them changes the shape of the encoder's core job — turning typed arrays
   into accessors and bufferViews — so building them alongside risks the
   same "mixing two concerns" slice 2 commit 6 already declined to do for
   `'stl'` dispatch.

   **Why an embedded `.gltf`, not a binary `.glb`.** A `.glb` packs a JSON
   chunk and a binary chunk behind 4-byte-aligned, length-prefixed headers —
   more compact, but every byte-for-byte correctness check in commit 3's
   tests would need to parse that binary framing before it could even get to
   the accessor math being tested. An embedded, single-buffer `.gltf` is
   valid glTF 2.0, loads in every real glTF viewer, and lets the test assert
   directly against JSON plus a decoded base64 string. Revisit for a `.glb`
   mode once the size of an exported file is a measured problem, not a
   hypothetical one — this project's own working method throughout
   `DECISIONS.md`.

   **Why decoder version is a hand-maintained table, not derived from each
   decoder.** ARCHITECTURE.md section 6a's cache-key design exists
   specifically because a decode-logic change can silently invalidate every
   previously cached result with nothing about the *file* changing — the
   SolidWorks 3-of-11-to-6-of-11 jump is the concrete example it cites. No
   decoder class currently exposes anything resembling a version, and
   computing one automatically (hashing each decoder's own compiled source,
   say) would be new machinery this slice doesn't need to invent. A single
   constant `ModelLoadManager` owns and bumps by hand, next to a comment
   pointing at this exact story, is the smallest thing that actually
   satisfies the requirement.

   **Why the etag fast path from ARCHITECTURE.md section 6a stays out of
   commit 6.** Checking the cache before downloading needs a `ModelSource`
   that actually sets `etag` — none of the four built-in sources do, so
   there is nothing yet to verify that path against. Deferred and logged in
   REVIEW-BACKLOG.md alongside the `optionsHash` gap above, both to close
   together whenever a real caller or a real options parameter exists.

6. **DXF.** Needs D6 settled first, because the 2D viewing model is open.

## 11. Still open

These do not block slices 1 to 5.

- **D6** — how 2D fits the viewer. Loading is settled; the drawing camera,
  layers and sheets are not.
- **D7** — what the demo page looks like.
- **D4, D5** — PMI, and AP242 tessellated files.
- **D9 follow-ups** — separating PMI geometry from part geometry, the
  `nist_ftc_11` miss, and testing more SolidWorks versions and SLDASM.

## 12. Known limits, stated up front

- Very large assemblies will not open. Browser-only conversion is a deliberate
  trade for privacy and zero hosting, made in D1.
- SolidWorks support is verified on 2018 and 2020, on parts only. 6 of 11 NIST
  parts reproduce their STEP bounding box exactly; 4 more decode correctly but
  include PMI annotation geometry; 1 is a real unexplained miss.
- SolidWorks files carry confidential data in plaintext, including customer
  paths and user names. The library must never log file contents.
