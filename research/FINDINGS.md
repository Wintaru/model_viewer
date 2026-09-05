# Research findings — web model viewer

Date: 2026-09-04. All measurements come from tests on this machine.

## 1. The core 3D stack works. I tested it.

OCCT (Open CASCADE Technology) compiled to WebAssembly reads STEP, IGES and
BREP in the browser. The package is `occt-import-js`. I ran it against the
33 NIST AP242 test files in `assets/step/`.

Result: **32 of 33 files parsed. 293,561 triangles in total.**

The importer returns more than triangles. It also returns:

- an assembly tree with node names,
- per-mesh and per-face colors,
- a `brep_faces` array that maps triangle ranges back to the original B-rep
  faces.

That `brep_faces` mapping is important. It lets a user click one face of a
model and get the original CAD face, not a triangle. Face picking and
measurement both depend on it.

Reproduce with `node research/probe-step.mjs`.

## 2. Speed is the first real problem

Parse time does not scale linearly with file size.

| File | Size | Parse time |
| --- | --- | --- |
| `nist_ftc_11_asme1_rb.stp` | 7 KB | 32 ms |
| `nist_ctc_03_asme1_rc.stp` | 246 KB | 148 ms |
| `nist_ftc_10_asme1_ap242-e2.stp` | 1.8 MB | 766 ms |
| `nist_stc_10_asme1_ap242-e2.stp` | 4.8 MB | 6,283 ms |
| `nist_ftc_08_asme1_ap242-e2.stp` | 4.6 MB | 8,371 ms |

These are small parts. A real assembly is much larger. Eight seconds on the
main thread freezes the page. Two conclusions follow:

- A Web Worker is the minimum requirement, not an optimization.
- Above some file size, conversion must move to a server. The server converts
  once and caches the result. Clients then load a light format such as glTF.

Decision D1 covers where that boundary sits.

## 3. Two different failure modes, and one is dangerous

**Hard failure.** `nist_stc_07_asme1_ap242-e3.stp` throws an exception with the
message `undefined`. The WASM layer loses the real OCCT error. Any product
built on this needs its own error handling.

**Silent failure.** `nist_ftc_08_asme1_ap242-e1-tg.stp` returns
`success: true` with **zero meshes**. The viewer shows an empty screen and
reports success.

I examined that file. It is an AP242 *tessellated geometry* file. It contains
`COMPLEX_TRIANGULATED_FACE`, `TESSELLATED_CURVE_SET` and `COORDINATES_LIST`
entities. It holds no B-rep. The mesh is already in the file, but the OCCT
XCAF reader does not return it.

This matters. AP242 tessellated files are the lightweight flavor of STEP, and
they are common. A viewer must detect this case and report it.

## 4. PMI does not survive the import

The importer result contains exactly three keys: `success`, `root` and
`meshes`. There is no PMI, no GD&T, no dimensions and no annotations.

The NIST files exist to test PMI. Every one of them carries geometric
dimensioning and tolerancing data. All of it is lost.

For a viewer that only shows shape, this is acceptable. For a viewer that
competes with a real CAD tool, this is a large gap. Decision D4 covers it.

## 5. SolidWorks: the container is open

**This section replaces an earlier version that said the opposite.** The first
version claimed the file was encrypted and that a do-it-yourself reader was
unrealistic. That conclusion was wrong. `DECISIONS.md` records both entries.

The error was specific and worth remembering: a `strings` scan found no
readable text, and I read that as evidence of encryption. Compressed data and
encrypted data both defeat `strings`. Absence of plaintext proved only absence
of plaintext.

### What the file actually is

Modern SLDPRT is **not** an OLE2 compound file. Files from about 2014 onward
use a chunked container. Reproduce with
`python3 research/scan-deflate.py <file>` and
`python3 research/recurse-sldprt.py <file> <outdir>`.

For `nist_ctc_01_asme1_rd_sw1802.SLDPRT`, 521,280 bytes:

- **22 raw-deflate streams cover 97 percent of the file.** They inflate to
  2,047,782 bytes. Some hold further zlib streams nested inside them.
- **Four Parasolid transmit streams** appear after recursion:

  | Stream | Size | Header |
  | --- | --- | --- |
  | `root/2@0x21ca` | 1,687 B | `TRANSMIT FILE (partition)` — schema only |
  | `root/5@0x38ae/0` | 129,095 B | `TRANSMIT FILE (partition)` |
  | `root/5@0x38ae/1` | 156,542 B | `TRANSMIT FILE (deltas)` |
  | `root/6@0x22fe4/4` | 3,630 B | `TRANSMIT FILE` |

  All report `modeller version 3000269`, schema `SCH_3000269_30000_13006`.
  That is Parasolid v30, which matches SolidWorks 2018.

- The remainder is an **MFC `CArchive` object graph**. The serialisation is the
  documented MFC pattern: `FFFF` introduces a class descriptor, followed by a
  16-bit name length and the class name. Recovered names include `moPart_c`,
  `moFaceRef_c`, `moEdgeRef_c`, `moFilletSurfIdRep_c`, `moBiography_c`,
  `MWDocumentHeader` and `ui_CommandRecorder`.
- **PMI is present and named.** `moSwiftGtol_c`, `moSwiftGtolWithDatums_c`,
  `moSwiftLocationTol_c`, `moSwiftSizeTol_c`, `moDisplayDistanceDim_c`,
  `moDisplayAngularDim_c`. This is the data that the STEP path loses entirely
  (section 4).
- Two PNG previews and nine XML streams, including a materials list.

### So what actually stops us

Three layers, and only one is hard.

| Layer | Status |
| --- | --- |
| Open the container | **Solved.** Done in this session. Also done independently by [`openswx`](https://github.com/schwitters/openswx), MIT licensed. |
| Read the metadata | **Solved by `openswx`** — properties, mass properties, assembly tree, previews, drawing sheets. It stops before geometry. |
| Turn Parasolid XT into triangles | **The real work.** |

The third layer is large but it is not secret. The Parasolid XT format is
**publicly published** as part of the ISO 14306 (JT) specification, and a
format reference document is public. Two complications remain. SolidWorks
stores geometry as a base partition plus deltas, and that layering is not
documented. Tessellating trimmed NURBS surfaces is hard.

The second complication has a good answer: do not write a tessellator. Target
OCCT topology as the output, and let OCCT tessellate. The job becomes a
translator from XT entities to `TopoDS_Shape`, not a new geometry kernel.

What vendors have is not a secret. Datakit has worked on this since 1994. The
moat is 30 years of accumulated edge cases, not hidden knowledge.

### The shortcut: confirmed. SolidWorks caches a display mesh. (D8)

**Answer: yes.** Resolved 2026-09-04 08:27. This is the finding that changes
the cost of the whole project.

Every part examined contains exactly one stream holding these two serialised
class names:

```
uoTempFaceTessData_c      per-face tessellation
uoTempBodyTessData_c      per-body tessellation
```

That is the format naming its own contents. No inference needed.

Supporting evidence:

- **Size tracks triangle count.** Across 9 parts, the tessellation stream size
  correlates with the STEP triangle count at **r = 0.92**. Whole-file size only
  reaches r = 0.72. Bytes per triangle stay in a narrow band of 61 to 138.
- **A unit-vector cloud.** The same stream holds a float cloud spanning
  exactly `[2.0, 2.0, 2.0]`, which is what an array of normals looks like when
  it runs from -1 to +1.
- **Coordinates at the right scale.** Float values sit inside ±0.6 metres, and
  the parts they belong to measure the same order: `nist_ctc_01` is
  0.800 × 0.450 × 0.150 m, `nist_ctc_03` is 0.303 × 0.485 × 0.163 m. Parasolid
  and SolidWorks both work in metres, which is why the values are not in
  millimetres.

| Part | STEP triangles | Tessellation stream | Bytes/triangle |
| --- | --- | --- | --- |
| nist_ctc_01 | 2,828 | 287,403 | 101.6 |
| nist_ctc_02 | 23,772 | 1,571,118 | 66.1 |
| nist_ctc_03 | 3,226 | 330,420 | 102.4 |
| nist_ctc_04 | 15,840 | 962,813 | 60.8 |
| nist_ctc_05 | 7,589 | 520,374 | 68.6 |
| nist_ftc_06 | 8,656 | 645,267 | 74.5 |
| nist_ftc_07 | 8,068 | 935,937 | 116.0 |
| nist_ftc_08 | 7,106 | 790,877 | 111.3 |
| nist_ftc_09 | 4,892 | 674,626 | 137.9 |

**What this means.** A read-only SolidWorks viewer does not need to parse
Parasolid, and does not need to tessellate NURBS. The triangles are already in
the file. The remaining work is decoding one MFC-serialised record layout,
which is a bounded parsing job rather than a geometry-kernel job.

The B-rep path (section above) stays valuable for measurement, precise
section views and export. It is no longer on the critical path to a viewer.

**Done.** The record layout was decoded and the geometry renders. See
`research/d9-decode.py` for the format and the three traps, and
`ARCHITECTURE.md` section 6 for the diagrams. Verified against independent
ground truth: 6 of 11 NIST parts reproduce the bounding box measured from
their STEP twin with OCCT.

### A method note worth keeping

The first two attempts at this test returned "no mesh found", and both were
wrong. A positive control caught it.

I ran the detector against `assets/mesh/3DBenchy.stl`, a real binary STL with
225,706 triangles. It found nothing. Two defects came out of that:

1. **The run-length threshold was far too high.** Real mesh formats interleave
   coordinates with normals and per-record attributes. Binary STL puts a
   2-byte attribute field after every 50-byte triangle, so contiguous float
   runs never exceed 12 values. The threshold demanded 36.
2. **Byte alignments were pooled.** Reading a float array at the wrong offset
   produces plausible-looking garbage. Mixing those with real values destroyed
   the bounding box.

After both fixes the control recovered 3DBenchy's box to within 2 percent, and
only then was a negative result worth anything.

**A detector that has never found anything has not been tested.** Run the
control first. `research/d8-final.py --control` does it.

### Legality

Reverse engineering a file format for interoperability is well established.
US law provides an interoperability exception in DMCA section 1201(f), and
*Sega v. Accolade* and *Sony v. Connectix* support intermediate copying for
that purpose. EU Software Directive Article 6 permits decompilation for
interoperability. The Open Design Alliance built its whole business this way
with DWG.

Two points of care. First, no DRM is being circumvented here, because deflate
is compression and not an access control. Second, the SolidWorks licence
agreement forbids reverse engineering, and that binds people who accepted it.
Anyone who has accepted it should not work on the parser. Use public sample
files, such as the NIST corpus in `assets/`, and keep the provenance clean.

This is not legal advice. Get a real opinion before the project gets popular.

### SLDDRW

`openswx` already reads drawing sheet names and view references. The geometry
of a drawing is a separate data model again: sheets, views, dimensions and a
title block. Treat it as separate work, not as a small addition to SLDPRT.

## 6. Licensing

OCCT uses LGPL 2.1 with an exception that permits static linking into a
closed-source application. **For an open-source project this question mostly
disappears.** LGPL suits an open-source viewer without needing the exception
at all.

The open-source constraint does rule things out at the other end. A commercial
CAD SDK ships as a proprietary binary and cannot live inside an open
repository. That removes ODA, CAD Exchanger, HOOPS and Datakit on licensing
grounds, before cost even enters the discussion.

It also opens one door: **LibreDWG is GPL**, which an open-source project can
use. That matters for DWG in section 8.

## 7. Prior art

`Online3DViewer` (`3dviewer.net`) is MIT licensed and reads 3dm, 3ds, 3mf,
amf, bim, brep, dae, fbx, fcstd, gltf, ifc, iges, step, stl, obj, off, ply and
wrl. The same author wrote `occt-import-js`. Read this project before writing
any code. It answers many questions about format coverage for free.

It does not solve native CAD formats, PMI, 2D, or large-model streaming. Those
gaps are where new work belongs.

## 8. The 2D picture

- **DXF** is solved. `dxf-viewer` renders DXF through three.js with instanced
  drawing, layer control, font support and a Web Worker path.
- **DWG** needs the ODA Drawings SDK, or the LibreDWG library, which is GPL.
- **PDF** works through `pdf.js`.
- **SLDDRW** has no open path. See section 5.

I could not download sample DXF files in this session. The candidate URLs
returned 404. `fileexamples.com` and the LibreDWG test suite are the next
places to try.

## 9. Compression, for later

Draco reduces geometry by 70 to 95 percent but loses precision. Meshopt
compresses losslessly, decodes faster, and matches Draco when combined with
gzip. Meshopt is the better default for CAD, because CAD users care about
dimensional accuracy.

## Sources

- [occt-import-js](https://github.com/kovacsv/occt-import-js) ·
  [npm](https://www.npmjs.com/package/occt-import-js)
- [Online3DViewer supported formats](https://3dviewer.net/info/)
- [Open CASCADE licensing](https://dev.opencascade.org/resources/licensing) ·
  [added-value components](https://www2.opencascade.com/components/)
- [ODA MCAD SDK](https://www.opendesign.com/products/mcad-sdk) ·
  [MCAD SDK membership update](https://www.opendesign.com/blog/2025/october/mcad-sdk-membership-update)
- [CAD Exchanger SDK pricing](https://cadexchanger.com/products/sdk/pricing/) ·
  [Web Toolkit](https://cadexchanger.com/products/web-toolkit/)
- [HOOPS Exchange](https://www.techsoft3d.com/developers/products/hoops-exchange/)
- [Zoo Design API](https://zoo.dev/design-api)
- [APS business model](https://aps.autodesk.com/blog/aps-business-model-evolution)
- [NIST MBE PMI downloads](https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0)
- [dxf-viewer](https://github.com/vagran/dxf-viewer)
- [ABC dataset](https://deep-geometry.github.io/abc-dataset/) ·
  [step.parts](https://step.parts)
