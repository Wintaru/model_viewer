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

Slice 1 commit 14's smoke demo: proves `ModelLoader` (`@wintaru/part-viewer`)
and `toThree` (`@wintaru/part-viewer/three`) work together in a real
browser, not just under Vitest. It decodes a small hand-built binary STL (a
cube — no test corpus needed) and renders it with three.js. This is
deliberately not the designed viewer: the actual UI is decision D7, still
open in `WAYFINDER.md`.

Open `library-demo.html` directly for the same reason `viewer.html` needs no
server: everything is bundled into one classic script,
`library-demo.bundle.js`, with no `import` statements left in it. A
`<script type="module">` referencing `../src/index.ts` would fail to load
over `file://` in every major browser — each cross-file module fetch is
blocked as cross-origin there — which is exactly the constraint that makes
`viewer.html` inline its geometry instead of fetching it.

Rebuild the bundle with:

```
pnpm run build:demo
```

This bundles `library-demo.ts` straight from `src/` (not from `dist/`), so
it doesn't need `pnpm run build` first.

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
