# Contributing

Thank you for looking at this project. It is small, and a good report or a
small patch both help.

## The one rule that is different here

**Never commit file content decoded from a CAD file, and never paste it into
an issue or a pull request.**

This is not a style preference. A SolidWorks file stores customer folder
paths, user names, and part numbers as plain text. A decoded model is the
part's full geometry. Any of that can leave your company through a debug
print that reaches a commit message, a test fixture, or a bug report.

So:

- Do not attach a CAD file to an issue. Describe it instead. The bug report
  template asks for the facts that help.
- Do not add a CAD file to this repository. The test corpus comes from NIST,
  which states it may be used without restriction, and `pnpm assets` fetches
  it. `assets/` is not in git.
- Do not print decoded bytes or strings anywhere that gets committed. Use
  `demo/private/`, which is in `.gitignore`, while you work.
- Diagnostic codes and messages are safe to share. They hold no file content.

## Getting started

This project uses `pnpm` and needs Node 22.12 or later.

```
pnpm install
pnpm run verify
```

`pnpm run verify` runs the type checker, ESLint, `dependency-cruiser`,
Prettier, and the tests.

Tests that need a real CAD file skip when the corpus is absent, so a fresh
clone is green. To run them, fetch the corpus first:

```
pnpm assets
```

That downloads about 75 MB from NIST. Continuous integration does the same,
so those tests do run before a merge.

## Before you open a pull request

```
pnpm run verify
pnpm run build && pnpm run check:dist
```

The second command matters more than it looks. Everything else in this
repository reads `src/`. `check:dist` is the only check that loads the
compiled files a user actually installs. A defect that reaches only those
files is invisible to every other check. That has happened once already.

## How the code is organised

Read `ARCHITECTURE.md` section 2 first. It holds the layer rules, and it is
authoritative. `dependency-cruiser` enforces them, so a call across a
forbidden boundary fails `pnpm run lint` rather than reaching review.

The rule that catches people: anything may import `Common`, `Common` imports
nothing, and **no component may call another component in its own layer**.

`SPEC.md` and `ARCHITECTURE.md` are planning documents, and both contain
statements now known to be wrong. `REVIEW-BACKLOG.md` lists them. Check it
before you trust a detail from either.

## What makes a change easy to accept

- **A claim about a format needs a file anyone can download.** This project
  says "verified" only about results a reader can reproduce. A fix backed by
  a file that cannot be shared is still welcome, but say so, and it will be
  described as narrowly as the evidence supports.
- **Small commits.** One idea each.
- **A test that fails before the change.** For a decoder, prefer a synthetic
  fixture built in the test over a real file, so the test runs without the
  corpus.
- **Say what you measured.** This project's history is a research trail.
  Numbers with a method beat confident prose.

## Reporting a security problem

Do not open a public issue. See `SECURITY.md`.

## Code of conduct

See `CODE_OF_CONDUCT.md`.
