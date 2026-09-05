# Review backlog

Findings from the code review of the initial commit that were **not** fixed in
it. Blocking defects were fixed; these are advisory and are recorded here so
they are not rediscovered.

Nothing here blocks build slice 1.

## Applies to the research scripts

These scripts are kept as an audit trail of how the SolidWorks format was
decoded, so some duplication between them is deliberate. That does not make the
defects below wrong, only lower priority.

- **`recurse-sldprt.py` still has the unpatched inflate loop.** The other six
  copies now use a `memoryview` and a shared byte budget. This one did not match
  the patch pattern and was left alone. It has a 32 MB per-stream cap and no
  aggregate cap.
- **`hash()` used for stream deduplication** — `d9-decode.py`,
  `d9-extract-mesh.py`, `d9-decode-tess.py`. Python's `hash()` on bytes is a
  64-bit, per-process-randomised siphash, not an identity. A collision silently
  drops a real stream. Use `hashlib.sha256`, or store the bytes. Note this only
  removes *exact* duplicates: a stream that also appears inside a parent buffer
  is still counted twice.
- **Argument handling raises `IndexError` instead of printing usage.** Every
  script documents a `Usage:` line and then indexes `sys.argv` directly.
  `sldprt-triage.py` does it correctly; copy that guard.
- **`d9-verify-cached.py` imports the decoder by splitting on a source string**
  (`.split('src = pathlib.Path')[0]`). The intent is right — the verifier must
  not drift from the decoder — but renaming a variable in `d9-decode.py` makes
  the whole module execute with the wrong `sys.argv`. Move `decode_stream` and
  its helpers behind `if __name__ == "__main__":` and import normally.
- **`d8-ground-truth.mjs` swallows a parse error** (`catch { continue; }`). A
  throwing STEP file vanishes from `d8-truth.json` with no output, which
  silently changes the denominator in "6 of 11". One NIST file is known to throw
  with the message `undefined`. Log the filename and the error.
- **`new URL(...).pathname` breaks on paths with spaces, and on Windows** —
  `d8-ground-truth.mjs`, `probe-step.mjs`. Use `fileURLToPath` from `node:url`.
- **`d8-final.py` prints the same value under two headings.** The summary table
  declares `STEP tri` and `need pts` and fills both from `tri`. Points needed is
  presumably `tri * 3`, so the threshold is understated threefold.
- **Crashes on empty or very small input** — `scan-deflate.py` divides by
  `len(data)`, `probe-sldprt.py` calls `min()` on a possibly empty list,
  `d9-map.py` indexes `kinds[0]`.
- **`recurse-sldprt.py` builds a `leaves` list that is never read.**
- **`d9-verify.py` leaks a temp file if `json.loads` throws.** Use `try/finally`.

## Applies to the demo

- **three.js r128 loads from cdnjs with no `integrity` attribute**, in
  `build-demo.py` and the generated `viewer.html`. Add an SRI hash. r128 is also
  several years old.

## Applies to `scripts/fetch-assets.sh`

- **Nothing is verified about what was downloaded.** No checksum, no size check,
  no assertion on extracted file counts. Every research number in
  `FINDINGS.md` and `d8-truth.json` assumes that exact corpus, so if NIST
  reissues either archive the audit trail becomes unreproducible with no signal.
  The script already computes the counts; turn them into assertions and record a
  SHA-256 per archive.
- **`find ... -exec cp` follows symlinks** in the extracted tree. Add `-type f`.

## Documentation consistency

- **The Utility roster is listed in three places** — `ARCHITECTURE.md` section 2,
  `SPEC.md` section 3, and the ASCII layer map in `SPEC.md`. They already
  disagree: `Hash` appears only in `ARCHITECTURE.md`, and it is load-bearing for
  the cache key. Make one authoritative and have the others point at it.
- **`research/README.md` indexes 8 of 16 scripts** and omits the entire D9
  phase, which is the half that produced the working decoder and the demo. It
  claims to be the audit trail, which is the stated reason the duplication is
  kept, so an incomplete index costs most of that value.
- **`SPEC.md` gives the wrong reason for scanning four byte alignments.** It says
  SolidWorks changes its container between releases. The real reason is that
  headers are not word-aligned *within a single file*.
- **"Exactly" overstates the verification tolerance.** `SPEC.md` says 6 of 11
  parts reproduce the box "exactly"; the check in `d9-verify-cached.py` allows
  2 percent or 0.5 mm. `ARCHITECTURE.md` phrases it better.
- **The SolidWorks 2020 claim is not reproducible from this repository.** All 11
  tracked SLDPRT files are 2018. The 2020 result came from a third-party file
  that is correctly gitignored. Say so, rather than leaving a claim nobody can
  check.
- **`sldprt-triage.py` cites a "9-part NIST corpus"** while `assets/README.md`
  documents 11 SLDPRT files. Both are true — the bytes-per-triangle table covers
  9 — but say "9 of the 11".

## From building slice 1 commit 5 — Common types (2026-09-05)

- **`SPEC.md` section 6 and `ARCHITECTURE.md` section 7 both show a
  `DecodedModel` code block that references `SceneNode` and `Diagnostic` but
  never defines either.** Slice 1 commit 5 had to design both from scratch to
  make the type compile — see `DECISIONS.md`. The two docs' code blocks are
  now stale duplicates of the real source in `src/common/`, the same
  situation the layer-rules table was in before commit 3. Once something
  consumes these types in a later commit, give the same treatment: point
  `SPEC.md`/`ARCHITECTURE.md` at `src/common/` instead of repeating the
  shape.

## From the review of CLAUDE.md and the slice-1 plan (2026-09-05)

Blocking findings were fixed. These were not.

- **The layer rules now live in four places** — the `ARCHITECTURE.md` section 2
  table, prose in `SPEC.md`, the ASCII map in `SPEC.md`, and `CLAUDE.md`.
  `CLAUDE.md` now points at the table instead of restating it, and the table is
  declared authoritative. Slice 1 commit 3 added `.dependency-cruiser.js` as
  the executable copy, and `SPEC.md`'s prose restatement of the allow/forbid
  rules now points at the table instead of repeating it. The ASCII layer map
  in `SPEC.md` section 3 still duplicates the folder structure, but it draws
  the layer hierarchy, not the allow/forbid rules — lower priority, and
  coupled to the separate "diagrams in Mermaid, not ASCII" cleanup, not to
  this guard. Several standalone restatements of individual forbidden edges
  also remain in `SPEC.md` section 3 prose ("Manager must never call
  Manager", "Accessor-to-Engine is forbidden", etc.) — not new drift, but
  worth folding into this same cleanup if it's revisited.
- **`.dependency-cruiser.js` has no regression fixture of its own.** It was
  hand-verified once (scratch files under each layer folder, deleted before
  commit) but nothing catches a future typo in the ruleset — a dropped `/` or
  a wrong alternation member — before it either silently stops catching a
  real violation or starts flagging legitimate code. Worth a small fixture
  test once Vitest lands in commit 4.
- **The verify story lives in three places** — `.trillian-repo.json` (the
  executable source), `CLAUDE.md`, and `SPEC.md`. Now declared authoritative in
  one place, but the copies still exist.
- **`research/README.md` indexes 8 of 16 scripts** and omits the whole D9 phase.
  Still true, and now load-bearing: `CLAUDE.md` points at it for which scripts
  need numpy.
- **Built-in sources are named two ways — resolved for `fromBuffer` in slice 1
  commit 7.** `<Name>SourceAccessor` is the class implementing `ModelSource`;
  `from<Name>` is the public factory function that constructs and returns
  one, colocated in the same file (a separate `fromBuffer.ts` importing the
  class would itself be a forbidden Accessor-to-Accessor edge — see
  `DECISIONS.md`). `FileSourceAccessor`/`fromFile` (commit 8) and the slice 4
  remote sources should follow the same split.
- **`MeshDecodeEngine` scope.** Slice 1 hand-parses binary STL to avoid an
  Engine depending on three.js. OBJ, PLY, glTF and 3MF are still listed as v1
  formats and have no plan yet. Hand-parsing all of them is not obviously right;
  glTF in particular is large. Revisit before slice 1 commit 10 grows.
  `FormatSniffEngine` (commit 9) recognizes both ASCII and binary STL under
  one `'stl'` id, since telling a decoder "this is some kind of STL" is a
  reasonable sniff-level answer regardless of which variant is implemented.
  **Resolved for the ASCII case in commit 10:** `MeshDecodeEngine` reports
  an `ascii-stl-unsupported` error `Diagnostic` rather than mis-parsing it.
  OBJ/PLY/glTF/3MF are still unimplemented and undetected either way.
- **`FormatSniffEngine` does not detect IGES.** The `ISO-10303-21;` header it
  checks is STEP's; real IGES files use fixed-width 80-column card records
  with a section letter at column 73, an unrelated and more involved check.
  No IGES file exists anywhere in this repository to verify a heuristic
  against. Write real detection once one does — from the NIST corpus, or
  once `OcctDecodeEngine` (slice 2) is being tested against one.
- **`FormatSniffEngine` cannot recognize a large binary STL from a short
  "sniff first" prefix.** Binary STL's only signature is a triangle count at
  offset 80 that must make the total length add up — there is no magic
  prefix, so a `readRange(0, 4096)` prefix (ARCHITECTURE.md section 3)
  larger files stay `undefined` on, and the loader falls back to a full
  read. ASCII STL is unaffected. Not clearly fixable without either reading
  more of the file (defeating part of the fast path) or giving `transform`
  the total byte length as a second, separate signal.

## From building slice 1 commit 11 — ModelLoadManager (2026-09-05)

- **The public loader is named two ways.** `SPEC.md` section 7a's public API
  sketch imports `ModelLoader` (`import { ModelLoader, fromUrl } from
  '@scope/cad-viewer'; const loader = new ModelLoader();`), but section 3's
  layer map, the build-order table, and `ARCHITECTURE.md` all name the
  component `ModelLoadManager` — which is what slice 1 commit 11 actually
  built, since that is the name the build-order table gives it. Same
  unresolved-naming shape as the `fromBuffer`/`BufferSourceAccessor` item
  above: decide before commit 12 ("Build tooling + exports map") whether
  `ModelLoadManager` is re-exported under the friendlier public name
  `ModelLoader`, renamed outright, or the sketch in `SPEC.md` is the one
  that's wrong.
