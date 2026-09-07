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
  real structural container parsing over bounding the existing scan with a
  timeout or dropping SLDDRW from v1 — a timeout ships "fails cleanly on
  most files," not "SLDDRW actually works." Opened D13 for the concrete
  research this requires; D12's own Engine-shape sub-question now waits on
  it. (D13, next below, found the container isn't OLE2 after all —
  "structural parsing" turned out to mean reverse-engineering a proprietary
  marker/boundary pattern, not walking a known directory format.)
- **D13 — The modern SolidWorks container has no published spec; the fix is
  reverse-engineering a marker pattern, not walking OLE2, 2026-09-06 18:00.**
  Corrected this same map's own error from the D12 entry above (it wrongly
  claimed the 2014+ container is OLE2/CFBF-shaped — `ARCHITECTURE.md` section
  6 and `research/FINDINGS.md` section 5 both already say it isn't; the error
  was new to this session's D12 write-up, not an old one repeated). An Agent
  research pass (WebSearch/WebFetch plus this repo's own docs) found:
  no public spec exists for the modern ("2015+") container; `openswx` (MIT,
  actively maintained) is the closest prior art, but only does real OLE2
  directory parsing for its own *pre-2014* branch — for 2015+ it falls back
  to a **byte-marker scan** (`14 00 06 00 08 00`) plus ROL-decoded stream
  names, not a directory walk, and covers metadata/BOM only, not
  tessellation. Guessed recursive inflate (`collect`/`inflateAll`) couldn't
  be eliminated, only bounded — **D14 (next) found this guess wrong, in the
  good direction: it can be eliminated entirely** for the one thing this
  project actually needs from the container. The code for this belongs in
  `utility/` (e.g. `SolidWorksContainerUtil.ts`, beside `InflateUtil`), not
  `Common` or an Accessor: a stateless byte transform, SolidWorks-specific
  since there's no generic structure to abstract over. Opened D14 for the
  concrete reverse-engineering work.
- **D14 — The marker format works exactly as documented, and eliminates the
  scan entirely — validated, not just prototyped, 2026-09-06 18:16.** Found
  `openswx`'s actual C++ source (`libopenswx/src/internal/modern_parser.cc`,
  `rol_codec.h` — read directly via `gh api`, not taken on faith from its
  README) and it's a complete, byte-exact chunk format: search for
  `14 00 06 00 08 00`, the chunk header starts 4 bytes before it, fixed
  fields at fixed offsets give the compressed size, **the exact
  uncompressed size**, and a name length; the name itself is a simple
  rotate-cipher (key = byte 7 of the file) decode of the bytes right after
  the header, and the payload right after *that* is a single, non-nested
  raw-deflate blob of exactly the declared compressed size.

  Ported it to Python and ran it for real — not just against the container
  layout in the abstract, against actual files: **4 NIST SLDPRT files** (all
  public, safe to detail) each parse in 2-5 milliseconds and land the
  tessellation cache in a chunk named `Contents/DisplayLists` every time,
  including `nist_ftc_11`, D9's own unexplained miss (worth a follow-up look
  since this reads its full, correctly-sized 229,376-byte stream cleanly —
  not chased further here, out of scope for this ticket). Then, carefully —
  reporting only booleans, chunk names, and byte counts below, no path,
  property, or geometry content — against **3 real confidential files**
  (`the customer corpus`): the 358 KB part decoded the same way in
  2ms; the SLDDRW case uses a *different* but still generic, non-identifying
  chunk name, `Contents/VBLists`, consistent across both a 215 KB drawing
  (2ms) and the 13.5 MB drawing that needed manual killing under the old
  brute-force scan — this one now parses in **95 milliseconds**. Its
  `Contents/VBLists` chunk's declared uncompressed size (48,864,018 bytes)
  matches the actual `zlib` output length exactly, and matches the number
  D11 measured by hand months of wall-clock investigation ago.

  **This also corrects the "recursion can't be eliminated" guess directly
  above:** D11's original finding of a raw-deflate stream needing "one more
  explicit recursion past `scan-deflate.py`'s own output-cap ceiling" was an
  artifact of that ad hoc script's 8 MB per-attempt cap, not genuine nested
  container structure — the real chunk is one flat, singly-compressed blob,
  and its header states the exact decompressed size up front (no cap
  needed, no recursion, one `zlib.decompressobj(-15).decompress(...)` call).

  **This also means D12's Engine-shape sub-question is now answerable, not
  just unblocked:** the identical chunk-parsing algorithm handles SLDPRT and
  SLDDRW alike — the only difference is which chunk *name* carries
  `TessData` (`Contents/DisplayLists` vs `Contents/VBLists`), and this
  project's own existing filter (search the decompressed bytes for the
  `TessData` substring, already how `extractTessDataStreams` works today)
  doesn't even need to know the name in advance. That reads as "grows a
  mode," not "earns a new Engine" — but that's a recommendation, not a
  closed decision; flagging it for Josh rather than closing D12 unilaterally
  in the same ticket that was only asked to answer D14.

  **Confirmed by the real implementation, 2026-09-06 18:43 — and it's
  stronger than "grows a mode."** Josh asked to build this. Shipped
  `src/utility/SolidWorksContainerUtil.ts` (the algorithm above, TypeScript)
  and wired it into `SolidWorksDecodeEngine.ts`, replacing the old
  `collect`/`inflateAll` brute force outright rather than keeping both —
  `extractTessDataStreams`'s external contract (dedup, `TessData`-filtered,
  same return type) is unchanged, so every existing caller and test needed
  no changes beyond rebuilding synthetic fixtures in the real chunk format
  instead of a bare deflate blob. Ran `SolidWorksDecodeEngine.transform()`
  end to end (not just extraction) against the same 3 real confidential
  files: the SLDPRT decoded in 33ms with zero diagnostics; **both SLDDRW
  files decoded successfully too — 10ms for the 215 KB one, 825ms for the
  13.5 MB one — zero diagnostics, one real mesh each, through the exact
  same `SolidWorksDecodeEngine`, no SLDDRW-specific code anywhere.** So the
  honest answer to "does it grow a mode" is: it didn't need to grow
  anything — the existing content-sniffing design already generalized.
  Full test suite (209 tests, all real-file tests included) now runs in
  3.3 seconds total, down from a runtime dominated by two 45-60-second
  tests. Independent code review (foreground) confirmed the refactor
  preserves behavior and caught one real regression (the old aggregate
  decompression-budget guard had no equivalent in the new code — fixed by
  adding one back, scoped per `extractModernContainerChunks` call) plus one
  broken-cross-reference issue (this entry itself, and eight other files,
  cited "WAYFINDER.md's D13/D14" from a feature branch that didn't yet
  contain them — fixed by merging the two branches before commit, which is
  why this update carries a later timestamp than the commit it describes).

  **Not decided here, still Josh's:** whether SLDDRW formally joins v1 as a
  documented, supported format (this note is about what the code does, not
  what the product promises — the remaining D12 sub-questions below, viewing
  and the 2018-only caveat, are still open either way).
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
  own Engine?~~ **Recommended answer available, 2026-09-06 18:16 — see D14
  in Decisions so far, above.** The validated extraction approach handles
  SLDPRT and SLDDRW with the identical algorithm, which reads as "grows a
  mode." Left as a recommendation rather than a closed decision here —
  Josh's call to confirm.
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
(Decisions so far, above) — the concrete research question this decision
creates, resolved the same session (see there for what it found).

`FormatSniffEngine` misidentifying SLDDRW as `"solidworks"` and hanging
instead of failing fast is a real, separate, smaller bug in current
behavior — tracked for `REVIEW-BACKLOG.md`, not fixed inside this
wayfinder session (planning, not implementing). **Revised 2026-09-06
18:16, once D14 (Decisions so far, above) validated the fix: this is no
longer only a SLDDRW/new-format question.** The same marker-based
extraction is a direct, drop-in-shaped replacement for the byte-by-byte
scan `SolidWorksDecodeEngine.ts` already uses for every SLDPRT it decodes
today — millisecond parsing measured against real NIST files that
currently take 45-60 seconds (research-script figure) to several minutes
(measured in a real browser, this session's own D12 investigation). Not a
blocker on anything already shipped in the sense of "broken" — SLDPRT
decoding works — but a large, validated performance win available for it,
independent of whether SLDDRW itself ever joins v1.

### D7 — What does the viewer feel like? `[prototype]`

Tree, toolbar, measurement, section planes, exploded views, per-face
selection. Talking will not settle this. Build a canvas and look at it.

Now scoped by D0: this is the demo page that ships as the library's
documentation, not a product surface. It should show what a caller can build,
and stay small enough that its source reads as an example.

- **Render-mode toggle: solid / wireframe / points, 2026-09-06 19:15.**
  Existed in the earlier Python-built proof of concept (`demo/viewer.html`);
  missing from the current TypeScript `interactive-demo.html`. Josh asked
  for it back while debugging a real SolidWorks decode artifact (a
  malformed face on `customer part A`, DECISIONS.md) — wireframe
  would have shown the triangle-strip structure directly instead of
  needing a temporary per-strip color-coding patch to see it. Not built
  yet, deliberately (Josh: "don't build it, just add it to our TODO
  list") — logged here since it's squarely a D7 viewer-feel question, not
  a separate decision.
  **Built 2026-09-07.** A `<select>` in `interactive-demo.html`'s panel;
  wireframe toggles `MeshStandardMaterial.wireframe` on `toThree`'s own
  `Mesh` objects, points swaps in a hidden `Points` sibling (sharing the
  same `BufferGeometry`, so nothing decodes twice) built once per loaded
  shape. Scoped to 3D shapes only — a drawing is already all
  `LineSegments` (D6), so the control disables itself (keeping whatever
  mode was last picked) whenever `isDrawing(model)` is true. Verified by
  hand in a real browser against a NIST fixture: wireframe showed the
  triangle-strip structure exactly as hoped; points showed the same
  surface as a dot cloud, curvature and hole boundaries still legible.

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
