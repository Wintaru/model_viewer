# model_viewer

An open-source npm library that renders engineering CAD files in a browser.
All conversion runs on the client; nothing is uploaded. Version 1 targets
STEP/IGES, native SolidWorks parts, common mesh formats, and DXF.

The interesting part: **native SolidWorks files decode without SolidWorks,
without Parasolid, and without a commercial SDK.** The container is deflate, not
encryption, and it holds a cached tessellation.

Be careful how you restate that. What is actually verified: 6 of 11 NIST test
parts reproduce the bounding box measured from their STEP twin, within 2 percent
or 0.5 mm. **Parts only — assemblies are untested**, and only SolidWorks 2018 is
reproducible from this repository. Do not promise more than that in a README, a
package description or a pull request.

## Read these first

Read in this order and stop when you have what you need.

| # | File | What it gives you |
| --- | --- | --- |
| 1 | `ARCHITECTURE.md` | How the library is built: layers, load sequence, the SolidWorks format. Start here. Its section 2 table is **authoritative** for the layer rules. |
| 2 | `SPEC.md` | What to build and in what order. Section 10 is the build plan, broken down to individual commits. |
| 3 | `WAYFINDER.md` | Which design decisions are settled and which are still open. |
| 4 | `research/FINDINGS.md` | How the formats were investigated, with measurements. |
| 5 | `REVIEW-BACKLOG.md` | Known defects, deliberately deferred. |

**`SPEC.md` and `ARCHITECTURE.md` contain statements already known to be wrong.**
They are catalogued in `REVIEW-BACKLOG.md`. Check it before you rely on a
specific detail from either — for example the reason the SolidWorks decoder
scans four byte alignments is stated incorrectly in `SPEC.md`.

`DECISIONS.md` holds the rationale trail: every choice, why, and what was
rejected. It is **gitignored but present on Josh's machine**, so read it if the
file exists. It is the best source for *why*. The same applies to
`.trillian-repo.json`, which holds the verify commands and git conventions and
is likewise absent from a fresh clone.

## Where the work is

`git log --oneline` shows what has landed. `SPEC.md` section 10 has the plan.

Slices 1 to 5 are unblocked. Slice 6 (DXF) waits on decision D6. The demo in
slice 1 is a smoke demo only; the viewer's real shape is D7 and still open.

## Constraints that are easy to violate

1. **Never log or embed file contents.** SolidWorks files carry customer folder
   paths, user names and part numbers in plaintext. This is not only about
   committed code: debug output gets pasted into commit messages, pull requests,
   hand-off notes and test fixtures. Do not dump stream bytes or decoded strings
   anywhere that is committed or shared.
2. **Never commit output decoded from a third-party CAD file.** A decoded model
   contains the part's full geometry. Such output goes in `demo/private/`, which
   is gitignored. The committed demo uses a NIST part, usable without
   restriction.
3. **Layer boundaries are real, and one is easy to miss.** The allowed calls are
   in the `ARCHITECTURE.md` section 2 table — read it there rather than trusting
   a summary. The rule most often forgotten: **anything may import `Common`, and
   `Common` imports nothing**, and no component may call its own layer. That last
   clause is why `ModelExportManager` and `GltfEncodeEngine` exist as separate
   components. `dependency-cruiser` enforces all of this from commit 3 of
   slice 1, and its config is the executable copy of that table.
4. **The test corpus is not in git.** Run `pnpm assets` before any script that
   reads `assets/` — that is `d8-extract-cache.py`, `d8-final.py`,
   `d9-verify.py`, `probe-step.mjs` and `d8-ground-truth.mjs`. The rest take an
   explicit path argument and need no download.

## Verify

The commands live in `.trillian-repo.json` and that file is authoritative for
them. Run them all at once with `pnpm run verify` (typecheck, lint, format,
test, in that order — matches `.trillian-repo.json`'s `verify` block).

## Running things

Research scripts are Python 3; `research/README.md` records which need numpy.
Node scripts need `pnpm install` first.

Two demos, both self-contained files you open directly (no server needed):
`demo/viewer.html` (the SolidWorks decode, Python-built) and
`demo/library-demo.html` (the TypeScript library end to end, `pnpm run
build:demo` to rebuild its bundle). See `demo/README.md`.
