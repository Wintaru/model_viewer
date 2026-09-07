# @wintaru/part-viewer

An open-source library that renders engineering CAD files in a web browser.
Conversion runs on the client. No file leaves the browser.

The library reads STEP, IGES, native SolidWorks parts, common mesh formats,
and DXF drawings. It returns one neutral geometry model for every format, so
a caller can show any of them with the same rendering code.

## Status

Version 1.0.0. The public surface — `ModelLoader`, `ModelExporter`,
`toThree`, and `toThreeDrawing` — is stable, and a change that breaks it
raises the major version.

Version 1.0.0 does not mean every format is complete. It means the scope is
settled and the interface will hold. Read the next section for what the
library really does today, and the support table for each format. Both
describe narrower coverage than the version number alone suggests.

## What is verified, and what is not

Native SolidWorks files (`.SLDPRT`) decode without SolidWorks, without
Parasolid, and without a commercial software development kit. The container
inside a SolidWorks file uses ordinary deflate compression, not encryption,
and it holds a display mesh SolidWorks itself already computed and cached.

This decoder is checked against the NIST test corpus, a public set of CAD
files. Seven of eleven NIST test parts reproduce the bounding box measured
from their STEP twin, within 2 percent or 0.5 mm. Only SolidWorks 2018 is
reproducible from this repository.

Assemblies (`.SLDASM`) decode too, but that result is narrower. It is
measured against real assembly files that this repository cannot ship, so
you cannot reproduce it here. Assemblies that use the same component more
than once are unverified. See `WAYFINDER.md` for the specific risk.

Drawings (`.SLDDRW`) are **not supported**, and the library does not
currently say so. A drawing file opens, and what comes back is the 3D model
the drawing refers to, repeated once per view — not the drawing. Do not use
this library to read drawings yet. `WAYFINDER.md` decisions D21 and D22
cover why, and what a real drawing reader needs.

IGES support detects the format correctly and reports failures honestly, but
no IGES file with real solid geometry has been verified yet. See
`WAYFINDER.md` for open questions like this one.

## Supported formats

| Format | Route | Status |
| --- | --- | --- |
| STEP | OCCT, through WebAssembly | Verified against the NIST STEP corpus. |
| IGES | OCCT, through WebAssembly | Format detection and failure handling are verified. A real solid-geometry decode is not yet verified — see above. |
| SolidWorks parts (`.SLDPRT`) | This project's own decoder | Verified as described above. |
| SolidWorks assemblies (`.SLDASM`) | This project's own decoder | Decodes real assemblies. Repeated instances of one component are unverified — see above. |
| SolidWorks drawings (`.SLDDRW`) | Not supported | A drawing opens and returns the referenced 3D model, not the drawing. See above. |
| STL (binary) | Hand-written parser | Verified. |
| STL (ASCII) | Not yet supported | Reports a clear diagnostic instead of a wrong result. |
| DXF | This project's own parser | Lines, circles, arcs, and straight polyline segments, grouped by layer. Curved polyline segments and block references are not yet supported. |

OBJ, PLY, glTF, and 3MF are planned but not yet supported.

## Install

```
npm install @wintaru/part-viewer
```

To render a model, also install three.js. It is an optional peer dependency,
so a caller who only reads geometry — for a measurement, or a headless
conversion — does not need it and does not pay for it.

```
npm install three
```

## Quick start

```ts
import { ModelLoader, ModelExporter } from "@wintaru/part-viewer";
import { toThree } from "@wintaru/part-viewer/three";

// The two `undefined` arguments keep the built-in mesh sniffer and STL
// decoder. The third argument is the URL where your bundler serves OCCT's
// WebAssembly binary — needed only to read STEP and IGES files.
const loader = new ModelLoader(undefined, undefined, "/occt-import-js.wasm");

const model = await loader.load(file); // a File, a URL, bytes, or your own source
scene.add(toThree(model));

const exporter = new ModelExporter();
const blob = await exporter.export(model, { format: "gltf" });
```

`ModelLoader` reads the bytes and detects the format itself, not from a
file name or extension. It then loads only the matching decoder. STL loads
with no further setup. STEP and IGES share one decoder, loaded the first
time a caller opens either format. SolidWorks and DXF each load their own
separate decoder, the first time a caller opens that format. A caller
loads code only for the formats they actually use.

## Reading bytes from anywhere

`ModelLoader.load` accepts a `File`, a `Blob`, an `ArrayBuffer`, a
`Uint8Array`, a URL, or an object that implements this library's own
`ModelSource` interface. That interface is public, so a caller can read
bytes from any storage system — a signed URL from Supabase Storage, from
Amazon S3, or from Azure Blob Storage all work already, through the
built-in `fromUrl` helper. A caller with no URL at all — for example,
Electron, or the browser's Origin Private File System — can implement
`ModelSource` directly. See `SPEC.md` section 7 for the full contract.

## Entry points

| Import path | What it gives you |
| --- | --- |
| `@wintaru/part-viewer` | The loader, the exporter, and the neutral geometry model. No rendering library included. |
| `@wintaru/part-viewer/three` | A `toThree` function that turns a decoded model into a three.js object, for 3D formats. |
| `@wintaru/part-viewer/2d` | A `toThreeDrawing` function, an orthographic camera helper, and layer visibility, for DXF drawings. |

A caller doing headless work, such as measurement or a thumbnail, imports
only the core package. That caller's code does not load three.js.

## Known limits

- Very large assemblies will not open. This library converts every file
  inside the browser, by design, so no file is ever uploaded. A very large
  file can exceed the memory a browser tab allows, and this library does
  not yet work around that limit.
- SolidWorks files store some information in plain text, including folder
  paths, user names, and part numbers. Treat any SolidWorks file you decode
  as you would any other file containing that information.
- DXF paper space sheets, curved polyline segments, and block references
  are tracked as open work. See the issues on this repository.

## Demo

An interactive demo lives in `demo/`. See `demo/README.md` for what it
proves and how to run it locally.

## Contributing

Issues and pull requests are welcome. `CONTRIBUTING.md` has the detail, and
one rule there is worth repeating here: **never attach a CAD file to an
issue.** A SolidWorks file carries folder paths, user names, and part numbers
as plain text. Describe the file instead. The bug report template asks for
the facts that help.

Report a security problem privately. See `SECURITY.md`.

## Development

This project uses `pnpm` and needs Node 22.12 or later.

```
pnpm install
pnpm run verify   # type-check, lint, format check, and tests
pnpm assets       # fetch the test corpus, about 75 MB, not stored in git
```

Tests that need a real CAD file skip when the corpus is absent, so a fresh
clone is green without the download. Continuous integration fetches it, so
those tests do run before a merge.

To check the compiled package, rather than the source:

```
pnpm run build && pnpm run check:dist
```

`ARCHITECTURE.md` describes how the library is built. `SPEC.md` describes
what is built and in what order. `WAYFINDER.md` lists open decisions.
`REVIEW-BACKLOG.md` lists known defects in `SPEC.md` and `ARCHITECTURE.md`,
so read it before you trust a detail from either.

## License

MIT. See `LICENSE`.

STEP and IGES are decoded by [`occt-import-js`][occt], which carries a
compiled build of Open CASCADE Technology. That package is LGPL-2.1.

This library's own code is MIT, and it does not include or modify
`occt-import-js`. npm installs that package separately, beside this one, so
you receive it under its own licence and can replace it with your own build.
It is loaded only when a caller opens a STEP or an IGES file, through a
dynamic import, so a caller who opens neither never loads it. Every other
format in the support table is decoded by this project's own MIT code.

[occt]: https://github.com/kovacsv/occt-import-js
