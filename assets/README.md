# Demo and test assets

Downloaded 2026-09-04. Total size 75 MB. IGES samples added 2026-09-06 (57
KB — negligible against the total, listed separately below).

## `step/` — 33 files, 52 MB

NIST MBE PMI validation and conformance test files. STEP AP203 and AP242, in
editions e1, e2 and e3. Every file carries geometric dimensioning and
tolerancing data.

This is the best available STEP test corpus, because the files exist
specifically to break CAD software. They include one file that fails to parse
and one that parses to zero meshes. Both cases are documented in
`../research/FINDINGS.md`.

Source: [NIST MBE PMI downloads](https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0)

License: NIST states the files "can be used without any restrictions". NIST
asks for acknowledgement. Do not use the NIST logo.

## `iges/` — 3 files, 57 KB

Small reference files from an NBS/NIST-attributed IGES example archive.
None hold solid or surface geometry — they're wireframe entities (points,
lines, arcs, plus one drafting layout) — so they verify format detection
and OCCT's honest empty-result path (`OcctDecodeEngine`'s
`occt-empty-result` diagnostic), not a real solid decode. Finding a
solid-geometry IGES sample with clean, committable licensing is open
follow-up work — see `WAYFINDER.md`.

Source: [people.math.sc.edu/burkardt/data/iges](https://people.math.sc.edu/burkardt/data/iges/iges.html)

License: distributed under the GNU LGPL license per that archive's own
page; the files themselves are IGES specification reference examples
originally published by the National Bureau of Standards (now NIST).

## `solidworks/` — 11 files, 7.7 MB

The same 11 NIST parts in native SolidWorks MBD 2018 format.

These matter for two reasons. First, they are real SLDPRT files with a known
licence, which is rare. Second, the identical parts exist in `step/`, so any
SolidWorks reader can be checked against a known-good STEP result.

The archive also held CATIA V5, NX 1980, Inventor 2021 and Creo files for the
same parts. I did not keep them. Re-download the archive if a wider
interoperability test is needed.

Source and license: same as `step/`.

## `mesh/` — 1 file, 11 MB

`3DBenchy.stl`. The standard 3D printing benchmark model.

Source: [CreativeTools/3DBenchy](https://github.com/CreativeTools/3DBenchy)

## `gltf/` — 1 file, 3.6 MB

`DamagedHelmet.glb`. A physically based rendering test model with textures.
Useful to check that material handling works, because CAD files carry almost
no material data.

Source: [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)

## `2d/` — empty

Still needed. The DXF sample URLs I tried returned 404.

Next places to try: `fileexamples.com`, the LibreDWG test suite, and the test
data in the [`dxf-viewer`](https://github.com/vagran/dxf-viewer) repository.

## Larger corpora, not downloaded

- [ABC dataset](https://deep-geometry.github.io/abc-dataset/) — one million
  CAD models as STEP, Parasolid and STL. CC0. Use this for load testing and
  for finding parser failures at scale.
- [step.parts](https://step.parts) — about 16,000 STEP parts with a public
  API. Licenses vary per part. Check `THIRD_PARTY_NOTICES.md` in that project.
- [Fusion 360 Gallery](https://github.com/AutodeskAILab/Fusion360GalleryDataset)
  — 42,912 STEP files with segmentation data.

## Getting these files

They are not in git. Fetch them with:

```
pnpm assets          # or: bash scripts/fetch-assets.sh
```

`.gitignore` excludes `assets/*` and keeps only this README, so provenance and
licensing stay tracked while 75 MB of binaries do not.
