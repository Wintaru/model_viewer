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

- **The public loader is named two ways — resolved in slice 1 commit 12.**
  `SPEC.md` section 7a's public API sketch imports `ModelLoader`, while
  section 3's layer map, the build-order table, and `ARCHITECTURE.md` all
  name the component `ModelLoadManager`. Kept `ModelLoadManager` as the
  internal class (matches the layer-suffix convention every other Manager
  uses), and `src/index.ts` re-exports it as `ModelLoader` for the public
  surface — a caller of the published package has no reason to know iDesign
  layer vocabulary. `SPEC.md`'s sketch was already right; nothing there
  needed to change.

## From building slice 1 commit 14 — the library smoke demo (2026-09-05)

- **Nothing exercises the actual published `dist/` output.** `package.json`'s
  `exports` map points a consumer at `./dist/index.js` /
  `./dist/three/index.js`, but both `vitest` and `demo/library-demo.ts`
  (bundled by `scripts/build-library-demo.mjs`) import straight from `src/`.
  `pnpm run build` type-checks and emits `dist/`, but nothing then runs
  that output — so a real divergence between source behaviour and compiled
  behaviour (for example the already-known-and-accepted gap that `dist/`
  doesn't resolve under plain Node's ESM loader, see `DECISIONS.md`'s
  commit-12 entry) would only surface for an actual downstream consumer,
  never in this repo's own checks. Cheapest fix if this is ever worth
  closing: point `scripts/build-library-demo.mjs`'s `entryPoints` at
  `dist/index.js` / `dist/three/index.js` instead of `src/`, after a
  `pnpm run build` — traded away in commit 14 specifically so the demo
  bundler has one less prerequisite step, not because the gap doesn't
  matter.

## From planning slice 2 (2026-09-05)

- **`'stl'` dispatch stays outside `ModuleRegistry`.** Slice 2 introduces
  `ModuleRegistry` for lazy `import()`, but only wires `'step'` through it
  (`ModelLoadManager` still constructs `MeshDecodeEngine` eagerly, as it has
  since slice 1). `ARCHITECTURE.md` section 4 draws every format, mesh
  included, behind a dynamic import, so this is a known gap against the
  target shape, not the final state. Retrofit `'stl'` onto the registry
  whenever it's next touched, rather than as a standalone change — see
  `DECISIONS.md`'s slice-2 planning entry.
- **IGES still undetected and undecoded.** Unchanged from the entry above
  this section: no IGES file exists anywhere in this repository. Slice 2's
  `OcctDecodeEngine` implements `ReadStepFile` only for the same reason
  `FormatSniffEngine` still lacks IGES detection — nothing to verify a
  decode against. The two gaps should close in the same change, whenever a
  real IGES fixture becomes available.
- **`WasmAssetAccessor`'s default-`fetch` binding fix has no regression
  test.** Code review of commit 3 caught a real bug: the default `fetchImpl`
  captured the bare global `fetch` reference, which real browsers can
  reject with "Illegal invocation" when it's later invoked as
  `this.fetchImpl(...)` (a method call, not a bare `fetch(url)` call) —
  browsers brand-check `fetch`'s receiver, and this repo's test suite runs
  under Node (`vitest.config.ts` has no `environment: 'jsdom'`), whose
  `fetch` (undici) doesn't perform that check at all. Confirmed by hand:
  the exact failing shape (`this.fetchImpl(...)` with a bare `fetch`
  default) throws nothing under Node — it just does a normal network
  call — so no test in this suite can fail before the fix or catch a
  regression after it. Fixed by wrapping the default as
  `(input) => fetch(input)` rather than assigning `fetch` directly, but
  this is trusted-by-reasoning, not verified-by-test. Revisit if this
  repo ever gains a browser-based test target (Vitest browser mode,
  Playwright) — worth a real regression test then.
- **`OcctDecodeEngine` trusts, rather than verifies, that OCCT's
  `brep_faces` are already contiguous, non-overlapping and in ascending
  order.** `FaceRange`'s own doc comment (`src/common/FaceRange.ts`) states
  this as a load-bearing invariant — `BufferGeometry` groups silently drop
  or duplicate triangles when it doesn't hold, rather than erroring — but
  `toFaceRange` in `OcctDecodeEngine.ts` just maps `brep_faces` through
  unchanged. `OcctDecodeEngine.test.ts` only checks that the face counts
  *sum* to the total triangle count for one real file
  (`nist_ctc_01_asme1_rd.stp`), which is necessary but not sufficient — a
  set of ranges could sum correctly while still overlapping or gapping.
  Nothing in `research/probe-step.mjs` or `research/FINDINGS.md` documents
  occt-import-js guaranteeing this ordering, so it's an unverified
  assumption about an external boundary. A stronger test (sort by `start`,
  assert each range starts where the previous one ends, first `start === 0`,
  last end `=== indices.length`) would close the gap cheaply — worth adding
  next time this file is touched, flagged by code review of commit 4 as
  reasonable to defer rather than block on.
- **The `no-engine-to-engine` exemption for `*.worker.ts` files was broader
  than it needed to be — resolved in slice 3 commit 5.** Commit 5
  (`OcctDecodeEngineProxy` + `occt.worker.ts`) needed `occt.worker.ts` to
  import `OcctDecodeEngine.ts`, both under `src/engine/`, so
  `.dependency-cruiser.js`'s `no-engine-to-engine` rule exempted any
  `*.worker.ts` file on the FROM side entirely — unlike the Accessor
  rule's `ModelSource`/`ModelCacheAccessor` exemption, which narrows the TO
  side to an explicit allowlist. Flagged then as not yet worth narrowing,
  since only one worker and one Engine existed. Slice 3 commit 5 added a
  second worker (`solidworks.worker.ts` + `SolidWorksDecodeEngine`), the
  condition this note said to wait for, so two narrow rules
  (`occt-worker-only-imports-occt-engine`,
  `solidworks-worker-only-imports-solidworks-engine`) now restrict each
  `*.worker.ts` file to its own paired Engine, layered on top of the
  original blanket exemption rather than replacing it. Verified by hand
  (a temporary real cross-import, confirmed `depcruise src` catches it,
  then reverted) rather than trusted on the strength of the config alone —
  see DECISIONS.md.

## From building slice 3 commit 2 — SolidWorksDecodeEngine extraction (2026-09-05)

- **`extractTessDataStreams` has no skip-forward after a successful match,
  and its real-fixture test takes 45-60s.** Measured, not assumed: even
  `research/d9-decode.py`'s own C-accelerated zlib takes 36.37s for the same
  file, so the cost is inherent to trying every offset at up to 5 recursive
  levels, not a regression in this port — see DECISIONS.md. A real fix would
  need `InflateUtil` to report a safe lower bound on consumed compressed
  bytes (via incremental chunked `push()` calls against pako's public API,
  not its private `strm` internals) so the scan can skip past a stream it
  already found, the way `research/d9-decode.py` does with
  `decompressobj().unused_data`. Only one real NIST fixture runs in the
  default test suite specifically because of this cost (three fast
  synthetic tests cover the rest of the algorithm's behavior). Worth
  revisiting if `pnpm run test`'s growing runtime becomes a real problem —
  not fixed now because it's optimizing an already-reference-matching cost,
  not closing a correctness gap.

## From building slice 3 commit 4 — SolidWorksDecodeEngine.transform() (2026-09-05)

- **`SPEC.md` section 10 slice 1 says the TypeScript decoder should
  reproduce `demo/nist-ctc-01.json` "byte for byte."** Written before
  slice 3's design existed. `demo/nist-ctc-01.json` (generated by
  `research/d9-decode.py`) subtracts the model's centroid before writing
  vertices — a convenience for that one script's own demo viewer, not a
  property `DecodedModel` should have. `SolidWorksDecodeEngine.transform()`
  deliberately does not re-center (matching `OcctDecodeEngine`, which
  returns OCCT's native coordinates unchanged), so its output is the same
  geometry translated by the centroid, not byte-for-byte identical to that
  JSON. Verified instead against bounding-box *extents* (translation-
  invariant) — see DECISIONS.md. Fix SPEC.md's wording next time that
  section is touched; not urgent since nothing currently depends on the
  literal claim.
