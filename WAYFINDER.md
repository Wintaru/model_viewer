# Wayfinder map — web model viewer

Backend: markdown (this directory holds no git remote).
Created 2026-09-04.

## Destination

An open-source npm library that renders engineering CAD files in a browser,
converting them entirely on the client. Version 1 opens STEP and IGES, native
SolidWorks parts and assemblies, common mesh formats, and DXF drawings.

The motivating case is SolidWorks, which Autodesk Platform Services handles
badly for this purpose and which every commercial alternative gates behind a
proprietary SDK an open-source project cannot redistribute.

Revised 2026-09-04 12:14, after D0, D1 and D2 settled. The original wording
promised SLDDRW, which is now out of scope: no open path to it exists.

**Revised again 2026-09-06 — D11 found that a path does exist** (a decodable
tessellation cache, the same shortcut SLDPRT uses). SLDDRW is out of v1
scope by absence of a decision, not by absence of a path. See D12.

## Decisions so far

- **D0 — The deliverable is an embeddable npm library, 2026-09-04 12:14.**
  Other developers install it into their own web app. A demo page ships as
  documentation. No hosted service, so no server holds anyone's CAD files.
- **D1 — Conversion runs in the browser; sources are pluggable, 2026-09-04
  12:14.** Always client-side, in a Worker. Bytes may come from a file picker,
  an `ArrayBuffer`, a URL, or Supabase Storage. Remote *source* is not remote
  *conversion*, so nothing is uploaded.
- **D2 — SolidWorks v1 is mesh plus metadata, 2026-09-04 12:14.** Cached
  tessellation (working) plus properties, mass properties, assembly tree and
  preview. No Parasolid B-rep, no PMI, in v1.
- **Formats in v1, 2026-09-04 12:14.** STEP/IGES, SLDPRT/SLDASM, mesh formats,
  and 2D DXF. Not DWG (GPL only) and not SLDDRW (no open path — **superseded
  by D11, 2026-09-06: a path exists, but joining v1 is undecided, see D12**).
- **D10 — One package, lazy format registry, 2026-09-04 12:19.** The caller
  opens a file; the library sniffs the format and dynamic-`import()`s only that
  decoder. Measured: the OCCT WASM is 3.1 MB gzip / 2.3 MB brotli, so one
  all-in bundle was disqualifying for an embeddable library.
- **D3 — Neutral core, three.js adapter, identity preserved, 2026-09-04
  12:19.** Core returns typed arrays plus metadata; a thin adapter builds a
  three.js object. Face and strip identity ships from v1, because adding it
  later is a breaking change. The library can export a decoded result so the
  host can cache it.
- **D6 — DXF gets a second adapter; v1 viewing is model-space plus layers
  only, 2026-09-06.** A drawing's navigation (orthographic, pan/zoom, layer
  toggles, paper-space sheets) has nothing in common with the 3D adapter's
  orbit camera, so it ships as its own small adapter — sharing the loader,
  registry and neutral core with the three.js adapter, carrying no 3D-only
  concepts, and leaving the three.js adapter with no 2D-only concepts either.
  Paper-space sheet switching is real CAD-viewer behavior but is deferred past
  v1, tracked in
  [issue #1](https://github.com/Wintaru/model_viewer/issues/1). Slice 6 is now
  unblocked.
  **Refined 2026-09-06, once the actual `DecodedModel` shape got checked
  against DXF's geometry.** `DecodedModel.meshes` was pure triangle topology
  with no layer concept — "share the neutral core" wasn't automatically true.
  Extended `DecodedMesh` with an optional `topology?: 'triangles' | 'lines'`
  (default `'triangles'`, so nothing existing changes), one mesh per DXF
  layer, named after the layer. `DxfDecodeEngine` is our own small
  dependency-free entity parser (LINE/LWPOLYLINE/CIRCLE/ARC/POLYLINE,
  tessellating curves), not the `dxf-viewer` package SPEC.md originally
  named — that package decodes and renders together through three.js
  internally, which can't sit in a renderer-agnostic Engine. Rejected
  alternative: hand DXF bytes to `dxf-viewer` directly and skip the neutral
  model for this one format. Rejected because it would break the "one shared
  core" promise every other format keeps — export, caching and headless use
  would stop working uniformly for DXF specifically.
- **D11 — Yes: SLDDRW caches tessellation the same way SLDPRT does,
  2026-09-06.** Confirmed against a real customer drawing file (out of band,
  gitignored — see `research/FINDINGS.md` section 5). One nested stream
  carries the same `uoTempFaceTessData_c`/`uoTempBodyTessData_c`/`TessData`
  fingerprint SLDPRT's cached mesh carries, and `research/d9-decode.py`'s
  existing record-layout decoder — unmodified — recovers real triangles and
  unit normals from it. This resolves the question tracked in
  [issue #2](https://github.com/Wintaru/model_viewer/issues/2): SLDDRW is no
  longer "no open path," it is an untaken one. Whether it actually joins v1
  is a separate call — see D12.
- **D12 (partial) — SLDDRW extraction needs real container parsing, not a
  bounded version of the existing blind scan, 2026-09-06 17:52.** The blind
  byte-by-byte deflate scan (`collect`/`inflateAll` in
  `SolidWorksDecodeEngine.ts`) ran 400+ seconds with zero output against one
  of the smallest real SLDDRW samples available (215 KB) — not just slow on
  the known 13.5 MB outlier, stuck on ordinary-sized files too, and
  unpreemptable from outside since it's one long synchronous loop. Chose
  real OLE2/compound-file structural parsing over bounding the existing scan
  with a timeout or dropping SLDDRW from v1 — a timeout ships "fails cleanly
  on most files," not "SLDDRW actually works." Opened D13 for the concrete
  research this requires; D12's own Engine-shape sub-question now waits on
  D13's answer.
- **D9 — The tessellation cache decodes into triangles, 2026-09-04 09:24.**
  Layout known and verified: 6 of 11 NIST parts reproduce their STEP bounding
  box. See `DECISIONS.md`.
- **D8 — SolidWorks caches a display mesh. Confirmed 2026-09-04 08:27.** Every
  part holds a stream containing `uoTempFaceTessData_c` and
  `uoTempBodyTessData_c`. Stream size tracks triangle count at r = 0.92 across
  9 parts. A viewer therefore needs no Parasolid parsing and no NURBS
  tessellation. See `research/FINDINGS.md`, section 5.

## Specification

The settled decisions are bundled into **`SPEC.md`** (2026-09-04 12:27): layer
map, neutral geometry model, public API, packaging, and a six-slice build
order. All six slices are now unblocked; D6 settled slice 6 on 2026-09-06.

## Not yet specified — the frontier

Work one ticket per session. Resolve it, record it, then stop.

### D9 follow-ups `[research]` — not blocking v1

D9 itself is resolved (see Decisions so far). Three loose ends remain, none of
which block building:

- Separate part geometry from PMI annotation geometry. Four NIST parts decode
  correctly but report an oversized bounding box because annotation geometry
  is mixed in.
- Explain `nist_ftc_11`, which reports a box that is too small. A real miss.
- Test more SolidWorks versions, and test SLDASM. Only parts are proven, and
  only on 2018 and 2020.

### IGES follow-up `[research]` — not blocking v1

IGES itself was already in v1's scope (see "Formats in v1" above) — this is
the one gap left in delivering it, not a new decision. Detection and
decoding are both real and tested (`research/FINDINGS.md` section 10):
`FormatSniffEngine` recognizes real IGES files, and `OcctDecodeEngine`
calls `ReadIgesFile` and reports an honest empty result when a file holds
no solid or surface geometry — verified against three real IGES 5.3
samples.

What remains: none of those three samples hold real solid geometry, so a
positive decode — a real IGES file whose geometry actually produces
triangles — is unverified. Finding one with clean, committable licensing
(not a CAD marketplace with unclear per-file rights) is the open task.

### D4 — Does PMI belong in the product? `[research]`

`occt-import-js` returns no PMI at all. The NIST files carry full GD&T data,
and all of it is lost. Section 4 of the findings covers this.

Find out whether any browser-capable path preserves PMI. Check the OCCT XCAF
API directly, because the data may exist in OCCT and stop at the WASM
boundary. If it does, the fix is a fork, not a vendor.

### D5 — What happens with AP242 tessellated files? `[research]`

`nist_ftc_08_asme1_ap242-e1-tg.stp` reports success and returns zero meshes.
A viewer would show an empty screen and claim it worked.

Narrow and concrete. Find out whether OCCT can read `COMPLEX_TRIANGULATED_FACE`
through a different call, or whether this needs a separate reader. At minimum,
detect the case and report it honestly.

### D12 — Does SLDDRW join v1, and what does decoding and viewing it need? `[research]`

D11 settled the technical question: a decodable tessellation cache exists.
This is the scope question that follows it, same shape as D2 (SolidWorks
scope) and D6 (DXF adapter split) before it. Open sub-questions:

- ~~Does `SolidWorksDecodeEngine` grow a SLDDRW mode, or does SLDDRW earn its
  own Engine?~~ Blocked on the extraction-approach question below — deciding
  the Engine shape before knowing whether extraction is even fast enough to
  ship would be premature. Revisit once D13 (below) has an answer.
- ~~The container scan that found the cache needed one more explicit
  raw-deflate recursion past `scan-deflate.py`'s own output-cap ceiling…~~
  **Resolved and superseded, 2026-09-06 — see below: the real problem is
  much bigger than under-scanning.**
- Viewing: D6's `/2d` adapter already carries orthographic camera, pan/zoom
  and layer toggles. Sheets and multiple views per sheet are new surface on
  top of that, not obviously a fit without checking.
- Only one real sample file has been checked. The same "only 2018 is
  reproducible" caveat D9's follow-ups already carry for parts may apply
  here too.

**2026-09-06 17:52 — the scan-cost sub-question resolved, and it's worse than
logged.** A live investigation (a real user report: "SLDDRW files don't seem
to load") found `FormatSniffEngine.looksLikeSolidWorks` matches every SLDDRW
(same byte-4-7 `[0,0,0,4]` container signature as SLDPRT — confirmed against
a real file), so every SLDDRW gets dispatched to `SolidWorksDecodeEngine`,
which is scoped and tested for parts only. Timed `extractTessDataStreams`
directly against one of the *smallest* real SLDDRW samples available
(215,881 bytes, smaller than the 358 KB SLDPRT the same session had just
finished decoding in under a minute): it ran 400+ seconds with **zero
output** — not slow, not under-scanning, effectively stuck. The scan is a
tight synchronous loop with no `await`, so nothing outside it (a vitest
timeout, a hypothetical wall-clock guard bolted on from the caller) can even
preempt it mid-run. This is the *same* brute-force-every-byte-offset
algorithm the original D11 investigation already knew could churn for 5+
minutes on the 13.5 MB outlier's largest decompressed buffer — this new
finding shows the failure mode isn't specific to that one large file, it's
inherent to the algorithm applied to a drawing's stream structure at any
size tried so far.

**Decision: pursue real container parsing, not a bounded blind scan.**
Josh's call, given three framed options (bound the existing scan with a
timeout / drop SLDDRW from v1 entirely / parse the real container structure
directly). A timeout would ship something that mostly fails cleanly rather
than mostly hangs — not the same as SLDDRW actually working. Dropping it
loses real value (D11 already proved the cache is there and decodable in
principle). Real parsing is the only path to SLDDRW being fast enough to
ship, at the cost of being the bigger lift of the three. Opened as **D13**
below — the concrete research question this decision creates.

Not a blocker on anything already shipped. `FormatSniffEngine` misidentifying
SLDDRW as `"solidworks"` and hanging instead of failing fast is a real,
separate, smaller bug in current behavior — tracked for `REVIEW-BACKLOG.md`,
not fixed inside this wayfinder session (planning, not implementing).

### D13 — What does real OLE2/compound-file container parsing look like for a 2014+ SolidWorks file? `[research]`

D12's scan-cost finding rules out the blind byte-by-byte offset scan as a
real path to SLDDRW support. The alternative is parsing the container's
actual structure well enough to jump straight to the tessellation-bearing
stream, the way any OLE2 Compound File Binary Format reader would (SolidWorks
2014+'s container is exactly this shape per `ARCHITECTURE.md` section 6's
"Stage 1" — this project never had to parse it structurally before because
the blind scan was cheap enough for a single small part file).

Open questions this needs answered before any implementation:

- Is a 2014+ SolidWorks container a standard OLE2/CFBF structure (the same
  family `.doc`/`.xls` used), or SolidWorks-proprietary on top of it? If
  standard OLE2, a well-understood directory-and-FAT structure means a
  reader can walk it directly to the named stream instead of scanning.
- Does prior art exist for reading this without a vendor SDK? `openswx` was
  already surfaced once (D2) for property/metadata parsing — check whether
  it (or another MIT/BSD reader) parses the container structure itself, not
  just the tessellation record layout `research/d9-decode.py` already
  covers.
- Assuming OLE2: is the current recursive deflate-stream detection
  (`collect`/`inflateAll` in `SolidWorksDecodeEngine.ts`) still needed at all
  once the real stream is found directly, or does structural parsing replace
  it entirely? (`research/FINDINGS.md` section 5 and `DECISIONS.md`'s D11
  entry both describe the *existing* blind-scan approach — this question is
  about whether it survives once a real reader exists.)
- Scope check once the shape is known: does this become a new
  `Common`-layer utility (an OLE2 reader, reusable if IGES/STEP-adjacent
  formats ever need one) or a SLDDRW/SolidWorks-specific Accessor? Affects
  `ARCHITECTURE.md` section 2's layer table, not just this one decision.

Blocks D12's Engine-shape sub-question (does `SolidWorksDecodeEngine` grow a
mode, or does SLDDRW get its own Engine) — that can't be answered until the
extraction approach's actual shape is known. Not a blocker on anything
already shipped.

### D7 — What does the viewer feel like? `[prototype]`

Tree, toolbar, measurement, section planes, exploded views, per-face
selection. Talking will not settle this. Build a canvas and look at it.

Now scoped by D0: this is the demo page that ships as the library's
documentation, not a product surface. It should show what a caller can build,
and stay small enough that its source reads as an example.

**First real answer built 2026-09-06:** `demo/interactive-demo.html` — pick
any file, it decodes and renders, pan/zoom/rotate, Clear and try another.
Closes two concrete gaps the smoke demo (`library-demo.html`) had: DXF
rotated in 3D space along with everything else (a drawing now gets its own
non-rotating orthographic camera), and there was no way to try a file that
wasn't a fixture baked into the page. Tree, toolbar, measurement, section
planes, exploded views and per-face selection are all still open — this is
"a caller can view any file," not the full designed viewer.

## Out of scope

- **Autodesk Platform Services.** Ruled out by Josh before this map existed.
- **Commercial CAD SDKs (ODA, CAD Exchanger, HOOPS, Datakit).** Ruled out on
  2026-09-04. The project is open source, so it cannot redistribute a
  proprietary binary SDK. Cost was the smaller objection.
- **Writing a geometry kernel from nothing.** OCCT exists and its LGPL licence
  suits an open-source project well. Any Parasolid work targets OCCT topology
  as its output, rather than producing triangles directly.

Previously listed here and now removed: *"writing our own SLDPRT reader"*. It
was ruled out on 2026-09-04 07:26 and reinstated at 07:41 when the container
opened. See `DECISIONS.md` for both entries.
