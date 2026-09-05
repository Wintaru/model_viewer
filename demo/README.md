# Demo

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
geometry is safe to commit. Output decoded from any third-party file belongs in
`demo/private/`, which is gitignored: a decoded model contains the full
geometry of the part, and SolidWorks files also carry customer paths, user
names and part numbers in plaintext.
