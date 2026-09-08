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

**Settled 2026-09-07 — D21 closed this.** That path leads somewhere else: the
cached tessellation in a drawing belongs to the referenced *model*, not to the
drawing, so it can never render a drawing however well it decodes. Version 1
ships without SLDDRW and is otherwise complete. The real drawing data is in a
different chunk, and reverse-engineering it is now the active work — D22.

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

  **⚠️ Corrected 2026-09-07 14:03 — true at the byte level, misleading about
  meaning. See D21, below.** The cache a drawing carries is the referenced
  *model's* tessellation, held once per view that shows shaded geometry, all
  in model space with no view placement. Measured: a drawing returns exactly
  twice its own part's vertex and triangle counts, on two separate real
  files. So this is not "the same shortcut SLDPRT uses" pointed at a drawing —
  it is the SLDPRT shortcut returning SLDPRT data out of a drawing file. The
  path it opens does not lead to a drawing.
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
  (from the customer corpus): the 358 KB part decoded the same way in
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

  **⚠️ Corrected 2026-09-07 14:03 — every measurement above still holds, and
  "both SLDDRW files decoded successfully" reads as more than it proved. See
  D21, below.** What that run verified was the *container parser*, which does
  work on drawings, in milliseconds, exactly as claimed. Nobody checked what
  the resulting mesh depicted. It depicts stacked copies of the referenced 3D
  model, so the honest reading of this entry is "a drawing's container opens
  and yields a decodable mesh," not "SLDDRW works."
- **D15 — Close small tessellation-seam gaps, only from real boundary
  vertices, disclosed rather than silent, 2026-09-07.** Grew out of the D7
  render-mode toggle: using it on customer part A (a real customer part,
  named in DECISIONS.md) surfaced a dark region Josh suspected was a
  missing face. Pixel-sampling and a live `DoubleSide` backface-culling
  test proved that specific region was real, correctly-wound geometry
  (just dimly lit) — but a real watertightness check (every edge of a
  closed surface should be shared by exactly two triangles) found
  something genuine elsewhere: 77
  boundary edges forming 6 small loops, most plausibly SolidWorks
  tessellating each face independently and not sampling a shared curve (a
  hole rim, say) identically on both sides. Josh: other viewers paper over
  exactly this, and asked to mimic it — "for free" (using only vertices
  already in the decode, never inventing a position) rather than guessing.

  Shipped `src/repair/index.ts` (`repairSmallGaps`) as a third pure adapter
  alongside `/three` and `/2d` (ARCHITECTURE.md section 2) — depends only on
  Common, called explicitly by a consumer (a "Fix small gaps" button in
  `interactive-demo.html`, matching Josh's own framing), never automatic
  during decode. Finds boundary loops via a snap-merge across each mesh's
  own vertices, caps each with a triangle fan over the loop's real vertices
  plus one synthesized centroid, and skips (reporting via `diagnostics`
  rather than guessing) any loop too large relative to the *model's own*
  bounding diagonal — Josh's explicit choice over a fixed-mm threshold, so
  the same default behaves sensibly at any part scale. Patch triangles get
  a distinct colour (a visible orange) via a new `FaceRange`, so a repaired
  region never blends silently into real geometry — the same disclosure
  principle as the diagnostic itself.

  One real, hand-verified subtlety: fanning a hole's boundary using the
  vertex order its edges are naturally found in produces an **inverted**
  (inward-facing) patch — confirmed by working an example by hand, not
  assumed (DECISIONS.md) — so the fan reverses that order at the point of
  triangle construction. A unit test asserts patch normals agree in sign
  with the real geometry they replace, specifically to catch a regression
  here.

  Verified against the real file that prompted this: the watertightness
  check found the same 6 loops the manual investigation already had. At the
  library's own conservative default (5% of the model's bounding diagonal)
  all 6 were correctly left alone as too large. At 15% — verified by hand to
  visibly close two real gaps at the part's bolt holes without touching the
  unrelated dim face — 4 of 6 filled, 2 still correctly held back. The demo
  button uses 15%, chosen deliberately looser than the library's own
  default: a consciously-invoked, visually-inspectable, reversible (reload
  the file) action affords more latitude than a default a caller might never
  look at twice.

  **Reverted 2026-09-07 09:46.** The blanket rule — cap any small boundary
  loop — turned out unsound: on the real file it also capped a bolt hole that
  has to stay open, and nothing in a boundary loop's shape alone
  distinguishes a real opening from an unwanted seam gap. `git revert`
  removed `src/repair/index.ts` and its test; the `/repair` adapter, its
  dependency-cruiser rule, its `package.json` export and its
  `ARCHITECTURE.md` mention are gone with it. The actual root causes behind
  the real visual gaps this was built to paper over turned out to be two
  separate decoder bugs, found and fixed properly instead — see D16 and D17,
  next.
- **D16 — The unit-normal-ratio validity check was too strict, silently
  dropping real curved-surface tessellation blocks, 2026-09-07.** Grew out
  of investigating the same customer part A gaps D15 tried (and failed,
  see that entry's supersede note) to paper over. Chasing one
  specific visual gap by hand (pixel-sampling background-black, a live
  `DoubleSide` test ruling out backface culling) found nothing wrong at
  that exact spot — but a byte-level scan of every "4,8,2" marker
  candidate, including ones the decoder's own `normalsLookValid` check
  silently rejects, found two small (28-29 vertex) real tessellation
  blocks thrown out for having only ~50% of their normals within
  `UNIT_NORMAL_TOLERANCE` (then 0.05) of unit length — not the "occasional"
  exception that tolerance was tuned for, but half a filleted-bend strip's
  worth of smoothly-blended normals (measured 0.66-1.21, real and
  legitimate, not garbage). Widened `UNIT_NORMAL_TOLERANCE` to 0.5 in
  `SolidWorksDecodeEngine.ts` and the matching constant in
  `research/d9-decode.py` — `MIN_UNIT_NORMAL_RATIO` (0.8) untouched, still
  doing the real anti-garbage work.

  Verified, not assumed: recovers exactly the same 4,196/2,886
  vertex/triangle counts in the real TypeScript engine as in a Python
  reimplementation of the fix, and against the real file this
  investigation started from, makes the decoded surface fully watertight
  (0 boundary edges, up from 77) — resolving the actual root cause behind
  every gap D15 was trying to paper over after the fact. Checked against
  the whole NIST corpus, not just this one file: the existing "6 of 11
  reproduce their STEP bounding box" measurement (D9, next below) improves
  to 7 of 11 (`nist_ftc_11` now passes) with zero regressions on the other
  10. The specific *visual* notch that prompted this investigation turned
  out to be something else entirely — see DECISIONS.md for why it's most
  likely real, intentional geometry (a chamfer/relief cut the actual
  drawing confirms belongs there), not a defect.
- **D17 — Every decoded block's first strip-vertex had a zero-length
  normal, rendering as patchy wrong shading, not dim lighting,
  2026-09-07.** Josh pushed back on D16's claim that a remaining odd-looking
  region was "just lighting" — correctly: a *different* set of faces (edge
  bevels and chamfer strips, not the region D16 checked) really were wrong,
  not dim. Colour-coded each decoded block (a temporary debug patch,
  reverted) to match Josh's own screenshots to specific blocks, then
  measured those blocks directly rather than guessing again: every one of
  34 blocks in a real customer part had its first strip's first vertex (occasionally
  the second too) stored with a normal of exactly `(0,0,0)` — 49 of 392
  vertices total. A zero vector still shades under WebGL's Lambertian
  lighting (the dot product is just 0, not an error), so it renders as if
  lit by ambient light alone — patchy against the correctly-lit vertices
  right next to it on the same triangle. Reads as a leading anchor point in
  the cache's own strip format that never carried a real per-vertex
  normal, not corrupted SolidWorks data.

  Fixed in `SolidWorksDecodeEngine.ts`'s `assembleMesh`: any vertex whose
  stored normal is zero-length gets a real one recomputed from its own
  already-decoded triangle geometry (a face-normal average, the same
  technique mesh-processing tools use generally) — never inventing a
  position, only deriving a direction the position data already implies.
  Verified on the real file: 49/392 zero-length normals before, 0/392
  after, and the previously patchy bevel/chamfer edges render with smooth,
  consistent shading. Whole NIST corpus: vertex/triangle counts and the
  STEP-bounding-box check are both unaffected (this only changes normal
  *values*, never positions or topology), so nothing regressed.
  **Superseded 2026-09-07, see D18, below: the specific repair function
  this entry describes no longer exists** — replaced by a single
  from-scratch normal synthesis that makes a dedicated zero-length repair
  unnecessary (stored normals are never read at all any more). The
  diagnosis above (the defect, its cause, its measurement) remains
  accurate history.
- **D18 — Stored per-vertex normals have more than one distinct defect;
  the fix is to stop reading them at all and recompute from geometry,
  2026-09-07.** After D17 shipped, Josh found *more* wrong-looking faces
  and pushed back a second time on "it's just lighting" — correctly again.
  Investigation found a second, different defect: on every geometrically
  flat tessellation block (no curvature to justify variation), a real
  chunk of vertices carried a *non-zero*, unit-length stored normal
  pointing roughly 90 degrees off their own face's true direction — 98% of
  those turned out to exactly match a *different*, connected face's real
  normal (two faces meeting at a sheet-metal bend are near-perpendicular,
  so one face's true normal lies almost exactly in the other's plane).

  A first fix (`repairMismatchedFlatNormals`, checking only the 2-3
  triangles directly touching one vertex) shipped, then had to be
  reverted the same day: Josh reported new gradient artifacts across
  panels that should render perfectly flat. Root cause, found by diffing
  before/after normals on the real file: a gently curved surface can have
  any two *adjacent* triangles agree within the flatness tolerance even
  though the whole surface clearly isn't flat — the fix's own
  investigation had correctly checked flatness at the *whole-block* level,
  but the shipped code checked it per-vertex, a materially weaker test
  that kept mistaking pieces of real curves for flat spots and "correcting"
  them to a slightly different flat direction each time — exactly the
  patchwork-gradient look reported.

  Rather than patch that check again, replaced the whole repair strategy:
  `synthesizeSmoothedNormals` in `SolidWorksDecodeEngine.ts` throws away
  every stored normal and recomputes each vertex's normal from its own
  decoded triangle geometry, using the same technique every 3D/CAD tool
  exposes for exactly this decision (Blender's Shade Auto Smooth, 3ds
  Max's smoothing groups): weld vertices at the same real position, then
  blend normals across a shared edge only when the two faces meeting
  there are close to continuous (a fine tessellation of a real curve,
  measured on the real file: a clean gap in dihedral angles from 30 to 75
  degrees, so 45 sits with a wide safety margin), keeping a hard edge
  otherwise (a genuine part edge). Welding and blending are scoped to
  **one tessellation block at a time, never across blocks** — measured on
  the more complex NIST calibration parts, welding globally let an
  unrelated block's vertex drag a genuinely flat block's own normal
  towards a completely different face; scoping to one block eliminated
  every such case with zero cost to the actual defect (the real file's own
  problem vertices never needed cross-block welding to fix).

  Verified far more broadly than the reverted attempt: every one of the
  12 real files checked (the real customer part, 392 vertices; the whole
  11-file NIST corpus, up to 30,632 vertices) comes back with **zero**
  exceptions — every block SolidWorks's own tessellation is internally
  flat is now internally consistent, with no per-file tuning. Confirmed
  visually in a real browser: the panels that showed gradients under the
  reverted attempt now render uniformly flat, the bend stays crisp, and
  the genuinely curved hole walls still shade smoothly. See DECISIONS.md
  for the full investigation, including the two hypotheses (edge/tangent-
  vector leakage; coincidental match from a small direction palette)
  checked and ruled out before finding the real cause.
- **D19 — "Missing faces" on a second real customer part had two unrelated
  causes: a tail-marker parsing collision, and genuinely reversed winding
  in the source data, 2026-09-07.** Josh reported customer part B (named
  in DECISIONS.md) rendering with visible black gaps through solid-looking
  walls, and asked for the whole 62-file customer corpus to be swept, not
  just this one file fixed.

  **Cause 1, a real parsing bug:** the tail layout `a, b, 2, TOTAL` was
  matched on `TOTAL`'s value alone, without checking that the literal `2`
  actually precedes it. Three of this file's blocks have a vertex total of
  exactly `12` — the same value as `a`, the tail's own leading constant —
  so the search locked onto that earlier word instead of the real total,
  silently shifting where position/normal floats were read from for those
  blocks. Fixed by requiring the literal `2` immediately before the match
  in `findWordAfterTotalMarker` (`SolidWorksDecodeEngine.ts`), with the
  identical fix applied to `research/d9-decode.py`'s `_scan`. Verified via
  a directed-edge winding-consistency check (catches a shared edge two
  triangles traverse the *same* direction, which a plain edge-count check
  can't see): 0 non-manifold/flipped edges after, was 4/14; the known-good
  customer part A unaffected throughout.

  **Cause 2, found only by sweeping the whole corpus:** even after fixing
  Cause 1, 19 of 62 files still carried flipped-winding edges (up to 51 on
  one file) — traced to blocks whose tail words are completely well-formed,
  meaning the winding really is reversed in SolidWorks's own cached data
  (most likely a reversed-sense face in the underlying BREP). No parsing
  fix can distinguish this from a correctly-wound strip. Rejected
  propagating a canonical orientation via a cross-block BFS (the standard
  mesh-cleanup technique) — D18 already measured real cross-contamination
  from cross-block adjacency on complex parts, and rebuilding that same
  graph a second time for winding reintroduces the identical risk for
  comparatively little gain. Fixed one layer up instead: `src/three/
  index.ts`'s `materialFor` now renders `side: THREE.DoubleSide` rather
  than the (default) `FrontSide` — matching a choice the standalone
  `demo/viewer.html` demo already made — so backface culling can no longer
  hide correctly-positioned geometry just because its winding is
  backwards. Costs nothing visually on already-correct geometry (a closed
  solid's back side stays hidden behind its own front faces either way).

  Verified end to end: all 62 corpus files decode through the real
  `SolidWorksDecodeEngine.transform` with no diagnostics and non-zero
  triangle output; three files spanning both defect classes confirmed
  visually in a real browser (Playwright) rendering as complete, gap-free
  solids. Full verify green (tsc, eslint, depcruise, prettier, vitest — 218
  tests). See DECISIONS.md for the instrumentation approach and full
  detail.
- **D20 — SLDASM (assembly) decoding never actually worked; the chunk
  holding real geometry doesn't carry the `TessData` magic at all,
  2026-09-07.** Josh loaded a real assembly and got the generic
  "no valid tessellation block decoded" error — correctly questioning
  whether SLDASM had ever really been made to work, since the engine's own
  docstring already said it was untested. It hadn't: only container-level
  chunk *extraction* (D14) had been verified across SLDPRT/SLDASM/SLDDRW
  alike, never that the tessellation-block *decode* stage produces real
  geometry for an assembly. Listing every chunk in the real file (name,
  size, whether it contains `TessData`) found the actual cause: an
  assembly's `Contents/DisplayLists` chunk does contain the `TessData`
  substring, but only inside unrelated display-state tags
  (`uoTempAssemblySHDData_c` and friends) — a byte-level scan for the real
  "4, 8, 2, N" header found zero matches in it. The real per-component
  geometry instead lives in a separate `FaceTessellations/<id>` chunk (one
  per component) that carries no `TessData` substring anywhere, so
  content-sniffing alone can never find it.

  Fixed by widening `extractTessDataStreams`'s chunk filter to also accept
  a chunk by name prefix (`FaceTessellations/`), alongside the existing
  content-sniff. No change to the actual block-parsing logic at all — the
  real component chunk decoded correctly on the first try with the
  completely unmodified scanner (7,008 vertices, 4,772 triangles). Verified
  additive and risk-free for parts: no real SLDPRT file checked has any
  `FaceTessellations/*` chunk, so the new branch is structurally inert for
  the already-verified part path.

  Verified across the whole real corpus, not just Josh's one file: all 36
  SLDASM files in the customer folder now decode with real, non-zero
  triangle output (796 to 352,894 triangles); the existing 62-file SLDPRT
  sweep still passes 62/62, confirming no regression. Confirmed visually in
  the real browser demo: Josh's reported file now renders as a complete
  solid. Full verify green (tsc, eslint, depcruise, prettier, vitest — 220
  tests). Still open, stated plainly: only one real assembly, one
  SolidWorks version — multi-component assemblies, nested sub-assemblies,
  and suppressed components remain unchecked, so this narrows the existing
  "test SLDASM" frontier item rather than closing it (see below).
- **D21 — A drawing's cached tessellation is the referenced model's, not the
  drawing's. Version 1 closes without SLDDRW, and the real drawing chunk
  becomes the next research program, 2026-09-07 14:03.** Closes D12. Josh
  reported that SLDDRW files "render as 3D parts with extra stuff in them."
  They do, and the reason is structural, not a decoding defect.

  Three measurements settled it, all against real customer drawings
  (gitignored, aggregates only — see `DECISIONS.md` for the numbers):

  1. **What we render is N copies of the referenced model.** A drawing
     returns exactly twice its own part's vertex and triangle counts, on two
     separate files — `Contents/VBLists` caches the model's tessellation once
     per view that holds shaded geometry, in model space, with no view
     placement applied. An assembly drawing does the same at scale (220,028
     vertices). Stacked model copies is precisely the reported symptom.
  2. **The drawing's real content is in a chunk nothing here parses.**
     `Contents/Definition` is 786,808 bytes decompressed in a 215 KB drawing
     (against 10,166 for the same chunk in a part) and holds zero `4,8,2,N`
     tessellation headers on any alignment. Sheets, views, projected edges,
     dimensions and the title block all live there.
  3. **The one free raster path has a low ceiling.** Every drawing carries
     `Images/Sheet_0`, a real PNG of the laid-out sheet — verified by eye,
     with the views, dimension lines and title block all correctly placed.
     But it is fixed at 640x480 on every file checked (215 KB through
     13.5 MB), so the dimension text and title block are illegible. It is a
     thumbnail, not a viewable drawing.

  **Decision: reverse-engineer `Contents/Definition`.** Josh's call, given
  three framed options (detect SLDDRW and fail honestly, keeping it out of
  v1 / do that plus surface the 640x480 sheet thumbnail as a labelled
  preview / reverse-engineer the real chunk). The thumbnail path was
  rejected because it buys a preview rather than a drawing, at the cost of a
  raster-sheet concept in the neutral model and both adapters that nothing
  else needs. Failing honestly was rejected as the destination, not as a
  step — it settles for less than the project has already proved it can
  reach twice. **Version 1 is declared complete as it stands** (STEP, IGES,
  SolidWorks parts and assemblies, mesh formats, DXF), so this research is
  post-v1 work and blocks nothing. Opened as **D22**, below.

  **One live defect this leaves standing, deliberately, and it should not
  stay standing long:** today a SLDDRW decodes to stacked model copies and
  reports *zero* diagnostics — silent success on a wrong result, the exact
  failure mode `src/common/Diagnostic.ts` names as the worst one. D22
  supersedes it if it lands. Until then a v1 that ships this is a v1 that
  lies about drawings. Flagged for Josh rather than fixed inside this
  decision, since he chose the research path over the stopgap and the two
  are not exclusive.
- **D9 — The tessellation cache decodes into triangles, 2026-09-04 09:24.**
  Layout known and verified: 6 of 11 NIST parts reproduce their STEP
  bounding box. **Updated 2026-09-07 — see D16, above: now 7 of 11**, after
  fixing an overly strict tessellation-block validity check. See
  `DECISIONS.md`.
- **D8 — SolidWorks caches a display mesh. Confirmed 2026-09-04 08:27.** Every
  part holds a stream containing `uoTempFaceTessData_c` and
  `uoTempBodyTessData_c`. Stream size tracks triangle count at r = 0.92 across
  9 parts. A viewer therefore needs no Parasolid parsing and no NURBS
  tessellation. See `research/FINDINGS.md`, section 5.

## Specification

The settled decisions are bundled into **`SPEC.md`** (2026-09-04 12:27): layer
map, neutral geometry model, public API, packaging, and a six-slice build
order. All six slices are now unblocked; D6 settled slice 6 on 2026-09-06.

**Version 1 is complete, 2026-09-07 (Josh, closing D21).** It reads STEP,
IGES, SolidWorks parts and assemblies, common mesh formats, and DXF. SLDDRW
is not in it and does not hold it up — see D21. Everything still open below
is post-v1 work. Publishing the package is tracked separately, outside this
map.

## Not yet specified — the frontier

Work one ticket per session. Resolve it, record it, then stop.

### D9 follow-ups `[research]` — not blocking v1

D9 itself is resolved (see Decisions so far). Three loose ends remain, none of
which block building:

- Separate part geometry from PMI annotation geometry. Four NIST parts decode
  correctly but report an oversized bounding box because annotation geometry
  is mixed in.
- Explain `nist_ftc_11`, which reports a box that is too small. A real miss.
- Test more SolidWorks versions. Only parts are proven, and only on 2018 and
  2020. **Narrowed 2026-09-07, see D20, below: SLDASM decoding itself is no
  longer untested** — one real customer assembly now decodes and renders
  correctly — but assemblies with multiple components, nested
  sub-assemblies, or suppressed components remain unchecked, and the
  SolidWorks-version caveat still applies equally to assemblies. **A
  specific, named risk for the multi-component case, not just "unchecked"
  in general** (2026-09-07 code review of D20): a real assembly with two
  identical component instances (the same screw twice) could produce two
  byte-identical `FaceTessellations/*` chunks — `extractTessDataStreams`'s
  `dedupeByBytes` would then collapse them into one, silently dropping one
  instance's geometry, with no error and no diagnostic. Resolving this
  needs a real multi-component file to check against (does the cached
  tessellation bake in each instance's placement, or is dedup itself wrong
  once `FaceTessellations/*` chunks are in scope?), not a speculative fix.

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

### D12 — Does SLDDRW join v1? ✅ **Closed 2026-09-07 — see D21, above.**

No. The cached tessellation a drawing carries belongs to the referenced
model, not to the drawing, so it could never render one however well it
decoded. The viewing sub-question below never needed answering in the shape
it was asked: there is nothing to lay out on sheets, because the geometry we
recover is not the drawing's. Reverse-engineering `Contents/Definition` is
the live work now — **D22**, below.

The original ticket text follows, unedited, as the record of what was asked.

---

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

### D22 — Can `Contents/Definition` be read? `[research]` — post-v1

Opened 2026-09-07 by D21. This is the only path to a real SolidWorks drawing
viewer: vector views with readable dimensions, not a thumbnail and not the
3D model the drawing happens to cache.

What is known, from D21's measurements:

- Every drawing has exactly one `Contents/Definition` chunk. It decompresses
  cleanly through the existing `SolidWorksContainerUtil` — 786,808 bytes in a
  215 KB drawing, against 10,166 for the same chunk in a part. Size scales
  with drawing complexity, which is the right signal.
- It holds no `4,8,2,N` tessellation headers on any byte alignment, so none
  of this project's existing block decoders apply to it.
- Sheets, views, projected edges, dimensions, annotations and the title
  block are all unaccounted for elsewhere in the container, so they are
  almost certainly in here.

What makes this harder than the tessellation cache was, stated up front so
the difficulty is not rediscovered:

- **No magic-number anchor.** D8 through D14 all worked from a known
  fingerprint (`uoTempFaceTessData_c`, the `4,8,2,N` header, the
  `14 00 06 00 08 00` chunk marker). Nothing comparable is known here.
- **No prior art.** `openswx` parses metadata and BOM tables only, never
  drawing geometry. D13 already established no public spec exists for the
  modern container, and the same is true a level down.
- **No ground truth of the D9 kind.** Parts could be checked against a STEP
  twin's bounding box. A drawing has no neutral twin — though each real
  drawing in the customer corpus ships beside a PDF of itself, and the
  cached 640x480 `Images/Sheet_0` gives a correct, if low-resolution,
  picture of the expected layout. Both are checkable references.

First concrete steps, in order:

1. Characterise the chunk: entropy, repeated record headers, any embedded
   ASCII tags of the `uoTemp*` family, and whether structure is visible at
   all or the payload is further encoded.
2. Diff two drawings of the *same* part that differ in one known way (an
   added dimension, an extra view) to localise what encodes what.
3. Only then decide whether this is tractable. Report honestly if it is not
   — v1 does not depend on the answer.

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
  malformed face on customer part A, DECISIONS.md) — wireframe would
  have shown the triangle-strip structure directly instead of
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
