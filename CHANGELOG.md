# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — 2026-09-07

The first published release. Everything below is new, because nothing was
published before it.

### The library

- `ModelLoader` reads a file and returns one neutral geometry model, whatever
  the format. It detects the format from the bytes, not from a file name, and
  then loads only the decoder that format needs.
- `ModelExporter` writes a decoded model back out as glTF, so a caller can
  cache a conversion instead of repeating it.
- Three entry points. `@wintaru/part-viewer` is the loader, the exporter, and
  the model. `@wintaru/part-viewer/three` turns a model into a three.js
  object. `@wintaru/part-viewer/2d` does the same for a DXF drawing, with an
  orthographic camera helper and layer visibility. A caller doing headless
  work imports only the core, and never loads three.js.
- Conversion runs in the browser. No file is uploaded. STEP, IGES,
  SolidWorks, and DXF each decode in a Worker, so a large file does not block
  the page. STL decodes on the calling thread.
- `ModelSource` is public, so a caller can read bytes from any store. `fromUrl`
  covers a signed URL from Supabase Storage, Amazon S3, or Azure Blob Storage.
  `fromFile`, `fromBuffer`, and `fromResponse` cover the rest.

### Formats

- **SolidWorks parts** (`.SLDPRT`) decode with no SolidWorks, no Parasolid,
  and no commercial software development kit. Seven of eleven NIST test parts
  reproduce the bounding box measured from their STEP twin, within 2 percent
  or 0.5 mm.
- **SolidWorks assemblies** (`.SLDASM`) decode, against real files this
  repository cannot ship. Repeated instances of one component are unverified.
- **STEP** decodes through Open CASCADE, compiled to WebAssembly, and is
  verified against the NIST STEP corpus.
- **IGES** is detected, routed to the right reader, and reports failure
  honestly. No IGES file holding real solid geometry has been verified.
- **Binary STL** decodes. ASCII STL reports a clear diagnostic rather than a
  wrong result.
- **DXF** decodes lines, circles, arcs, and straight polyline segments,
  grouped by layer.
- **SolidWorks drawings** (`.SLDDRW`) are not supported. A drawing opens and
  returns the referenced 3D model instead of the drawing.

A decoder reports a failure through `model.diagnostics` rather than throwing,
so a caller can tell an empty result from a broken one.

### Known limits

See "Known limits" in `README.md`. The largest is memory: a very large
assembly can exceed what a browser tab allows, and this release does not work
around that.
