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

   Later slices get the same treatment when they are reached. Do not break them
   down in advance: the plan will be wrong by the time you get there.

2. **STEP and IGES.** `OcctDecodeEngine` behind the worker proxy, plus
   `WasmAssetAccessor` and the lazy import. Proves the packaging decision.
3. **SolidWorks.** Port `research/d9-decode.py` to TypeScript. Parts first,
   then assemblies, which are untested.
4. **Remote sources.** `UrlSourceAccessor` and `ResponseSourceAccessor`, plus
   the optional `readRange` path that lets the loader sniff a prefix and fetch
   the decoder in parallel with the download.
5. **Export and cache.** `ModelExportManager` with glTF out, plus
   `ModelCacheAccessor` and the key derivation.
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
