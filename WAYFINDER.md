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
  and 2D DXF. Not DWG (GPL only) and not SLDDRW (no open path).
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

### D11 — Does SLDDRW hold a cached-view container like SLDPRT's? `[research]`

Raised while settling D6. SLDDRW is out of v1 scope per a call made in
`research/FINDINGS.md` section 5 ("treat it as separate work"), but that call
predates D8/D9 — it was written before anyone knew SLDPRT hides a decodable
cached mesh behind plain deflate. SolidWorks drawings plausibly cache view
graphics the same way, for fast redraw, and nobody has looked with the
container-scan approach that cracked SLDPRT open.

Needs real SLDDRW sample files to scan — Josh has some. Tracked in
[issue #2](https://github.com/Wintaru/model_viewer/issues/2). Not a blocker:
slice 6 and D6's adapter split don't depend on the answer, and if SLDDRW does
turn out to be feasible, its viewing needs (sheets, layers) are the same
concepts D6's adapter and issue #1 already cover — this would add a decode
engine, not a new viewer architecture.

### D7 — What does the viewer feel like? `[prototype]`

Tree, toolbar, measurement, section planes, exploded views, per-face
selection. Talking will not settle this. Build a canvas and look at it.

Now scoped by D0: this is the demo page that ships as the library's
documentation, not a product surface. It should show what a caller can build,
and stay small enough that its source reads as an example.

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
