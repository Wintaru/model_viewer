<!--
Thank you for the pull request. CONTRIBUTING.md has the full detail. The
points below are the ones that come up most often.
-->

## What this changes

<!-- One or two sentences. Say what a user can do now that they could not do
before, or what stopped being wrong. -->

## Why

<!-- Link the issue if there is one. If this changes a claim about what the
library can decode, say what you measured, and against which file. -->

## Checks

- [ ] `pnpm run verify` passes.
- [ ] `pnpm run build && pnpm run check:dist` passes.
- [ ] No CAD file is added, and no output decoded from one.
- [ ] No file content appears in the diff, in a test fixture, or in this
      description. See CONTRIBUTING.md, "Never commit file content".
- [ ] A new claim about a format is backed by a file anyone can download.

## Layers

<!-- Delete this section if the change touches no file under src/. -->

`ARCHITECTURE.md` section 2 holds the layer rules, and `pnpm run lint` runs
`dependency-cruiser` against them. If you added a component, say which layer
it belongs to and why.
