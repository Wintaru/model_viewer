# Demo

Two demos live here, and they prove different things.

## `viewer.html` — the SolidWorks decode

A self-contained page that renders a SolidWorks part in a browser, with no
SolidWorks, no Parasolid and no vendor SDK. Open `viewer.html` directly — the
geometry is inlined, so it works from `file://` with no server.

Rebuild it with:

```
pnpm assets                                  # fetch the test corpus first
python3 research/d9-decode.py \
  assets/solidworks/nist_ctc_01_asme1_rd_sw1802.SLDPRT demo/nist-ctc-01.json
python3 research/build-demo.py demo/nist-ctc-01.json demo/viewer.html
```

This is the Python-path proof and stays until slice 3's TypeScript
SolidWorks decoder can reproduce `nist-ctc-01.json` byte for byte — see
`SPEC.md` section 10.

## `library-demo.html` — the TypeScript library, end to end

Slice 1 commit 14's smoke demo, extended in slice 2 commit 7: proves
`ModelLoader` (`@wintaru/part-viewer`) and `toThree`
(`@wintaru/part-viewer/three`) work together in a real browser, not just
under Vitest. This is deliberately not the designed viewer: the actual UI
is decision D7, still open in `WAYFINDER.md`.

It proves four things, with two different delivery requirements:

- **The STL cube** — a small hand-built binary STL, no test corpus needed.
  Open `library-demo.html` directly for the same reason `viewer.html` needs
  no server: everything is bundled into one classic script,
  `library-demo.bundle.js`, with no `import` statements left in it. A
  `<script type="module">` referencing `../src/index.ts` would fail to load
  over `file://` in every major browser — each cross-file module fetch is
  blocked as cross-origin there — which is exactly the constraint that
  makes `viewer.html` inline its geometry instead of fetching it.
- **A real STEP file** (`nist-ftc-11.stp`) — proves the slice 2 packaging
  decision: OCCT's `.wasm` fetched lazily, decoded off the main thread in a
  real `Worker`. Loaded through `fromUrl` (slice 4), so this also exercises
  the sniff-first fast path: `ModelLoadManager.load` reads a small prefix
  through `UrlSourceAccessor.readRange` to identify the format before the
  rest of the file has finished downloading. **This half needs the page
  served over http(s)** —
  confirmed by hand in a real browser, not assumed: a `file://` page gets
  an opaque origin, and constructing a `Worker` from one throws
  immediately, whether it's a classic or a module worker, regardless of
  whether the target script is same-directory or not. Opened directly over
  `file://`, this half is caught and reported in the status text
  ("STEP: skipped — …") rather than left as an uncaught rejection, so the
  cube still works exactly as it always has.
- **A real native SolidWorks part** (`nist-ctc-01.SLDPRT`, slice 3
  commit 7) — the same NIST part `viewer.html`'s Python-path proof already
  decodes (see the screenshot below), now proven through the TypeScript
  `SolidWorksDecodeEngine` instead. No `.wasm` this time, but still a real
  `Worker`, so this half carries the identical http(s)-only restriction and
  the identical caught-and-reported failure mode as the STEP half above.
  **Confirmed by hand this decode genuinely takes 60-150 seconds in a real
  browser** — the reverse-engineered scanning algorithm's cost, not a bug
  in the demo (see `research/FINDINGS.md` and `DECISIONS.md`); the status
  line only reports "SolidWorks: …" once that finishes.

  Serve the `demo/` directory over http to see either real-format half
  work:

  ```
  pnpm run serve:demo
  ```

  then open `http://localhost:8000/library-demo.html`.
- **Export and cache** (slice 5) — the STL cube is loaded twice through an
  in-memory `ModelCacheAccessor`, timing both loads: the second is a cache
  hit, so `MeshDecodeEngine` never runs again on identical bytes (confirmed
  by hand: one observed run measured 5.2ms for the first load and 0.0ms
  for the cached reload, in a real Chromium — the exact numbers will vary
  run to run). The cube is then exported through `ModelExporter` and
  offered as a real `smoke-cube.gltf` download link — confirmed by hand to
  be valid glTF 2.0 JSON with the expected mesh and accessor counts. Both
  need only the cube, so unlike the STEP and SolidWorks halves above, this
  works over `file://` too.
- **A DXF drawing** (`sample.dxf`, slice 6 commit 7) — a small
  hand-authored square-plus-circle fixture, two layers ("Outline" and
  "Detail"). Unlike the STEP and SolidWorks halves, this isn't a
  third-party file: it's our own content, written by hand, so it's safe to
  commit directly rather than needing NIST's usable-without-restriction
  provenance. Decoded through `DxfDecodeEngine` and rendered through
  `toThreeDrawing` (`@wintaru/part-viewer/2d`, the second adapter WAYFINDER
  D6 calls for) rather than `toThree` — proves the new decoder and adapter
  work together in a real browser, off the main thread in a real `Worker`,
  the same as the STEP and SolidWorks halves. Confirmed by hand: the status
  line reports "DXF: loaded 2 mesh(es) (layers: Outline, Detail)", one
  mesh per layer, matching the fixture exactly. Same `file://` restriction
  as STEP and SolidWorks, for the same reason (constructing a `Worker`).
  This demo stays a smoke test — one shared `PerspectiveCamera` orbiting
  every shape — so it does not also build a dedicated orthographic 2D
  viewport with layer toggles; that belongs to D7's still-open
  designed-viewer work, not this proof.

Rebuild everything with:

```
pnpm run build:demo
```

This bundles `library-demo.ts` straight from `src/` (not from `dist/`), so
it doesn't need `pnpm run build` first. It also bundles
`src/engine/occt.worker.ts`, `src/engine/solidworks.worker.ts` and
`src/engine/dxf.worker.ts` separately into `demo/occt.worker.bundle.js`,
`demo/solidworks.worker.bundle.js` and `demo/dxf.worker.bundle.js` — a real
consumer's bundler (Vite, webpack) would split these chunks out
automatically by recognizing `new Worker(new URL(...))` (ARCHITECTURE.md
section 4); this demo's plain esbuild script does it by hand instead — and
copies `occt-import-js`'s `.wasm` binary plus its LGPL license texts
(`license.occt-import-js.txt`, `license.occt.txt`) into `demo/`.
`SolidWorksDecodeEngine` and `DxfDecodeEngine` need no such binary: both
depend on nothing but pure JS (`pako` for the former; nothing at all for
the latter). All of these are committed rather than gitignored, the same
reason `library-demo.bundle.js` is: the demo works immediately after a
fresh clone (plus a server, for the STEP, SolidWorks and DXF halves), with
nothing to build first.

`occt-import-js.wasm` is LGPL-2.1, same as the two license texts committed
alongside it. LGPL-2.1 §6 requires the corresponding source be reachable,
not just the license text: it's built from
[kovacsv/occt-import-js](https://github.com/kovacsv/occt-import-js), which
in turn embeds [Open CASCADE Technology](https://dev.opencascade.org/) —
this repository does not fork or modify either, only redistributes the
former's published `dist/occt-import-js.wasm` build unchanged.

## Screenshots

**`shots/nist-ctc-01.png`** — the working case. `nist_ctc_01` decoded to
3,396 vertices and 2,296 triangles, with a bounding box of
800.00 × 450.00 × 150.00 mm. That matches the box measured independently from
the same part's STEP file with OCCT, exactly.

**`shots/pmi-annotation-geometry.png`** — a known limitation, kept because it
is useful. `nist_ctc_04` decodes its geometry correctly, but reports a bounding
box of 878 × 870 mm against a true 780 × 500 mm. The extra extent is real
geometry: the NIST PMI parts carry tessellated GD&T annotations, and the
leader lines trailing off the part in that image are what inflates the box.
Separating annotation geometry from part geometry is open work, tracked in
`WAYFINDER.md`.

## Why the demo uses a NIST part

The corpus NIST publishes may be used without restriction, so the decoded
geometry and the raw source files (`nist-ftc-11.stp`, `nist-ctc-01.SLDPRT`)
are all safe to commit. Output decoded from any third-party file belongs in
`demo/private/`, which is gitignored: a decoded model contains the full
geometry of the part, and SolidWorks files also carry customer paths, user
names and part numbers in plaintext.

`sample.dxf` isn't a NIST file — the NIST corpus has no DXF at all — it's
hand-authored, ordinary text we wrote ourselves, so the third-party
provenance question doesn't apply to it the same way.
