// Bundles demo/library-demo.ts (source, plus everything it imports from
// src/) into demo/library-demo.bundle.js: one classic <script> file with no
// import statements left in it, so its STL smoke test still loads over
// file:// like demo/viewer.html does. esbuild's JS API is used directly
// rather than its CLI — pnpm's generated node_modules/.bin/esbuild shim
// assumes esbuild's own bin/esbuild file is a Node script it can run via
// `node <path>`, but esbuild ships that file as the native binary itself,
// so the shim crashes trying to `require()` a Mach-O executable. The JS
// API resolves the real binary correctly and isn't affected. See
// DECISIONS.md.
import { copyFile } from "node:fs/promises";
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["demo/library-demo.ts"],
  outfile: "demo/library-demo.bundle.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "info",
  // library-demo.ts imports OcctDecodeEngineProxy.ts directly (see its own
  // comment on why), which carries a default parameter referencing
  // `import.meta.url` — never actually reached here, since the demo always
  // passes its own createWorker, but the expression is still part of the
  // bundled file and `import.meta` has no meaning in an IIFE, which
  // esbuild otherwise warns about on every build. Silenced, not fixed:
  // there's nothing to fix, the code path genuinely never runs.
  logOverride: { "empty-import-meta": "silent" },
});

// interactive-demo.ts: same shape, same silenced warning, same reason —
// it constructs OcctDecodeEngineProxy directly too. Reuses every worker
// bundle and the wasm asset the builds below already produce; needs no
// build output of its own beyond this one file.
await esbuild.build({
  entryPoints: ["demo/interactive-demo.ts"],
  outfile: "demo/interactive-demo.bundle.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "info",
  logOverride: { "empty-import-meta": "silent" },
});

// occt.worker.ts is loaded as a real Worker at runtime (new Worker(url)),
// not statically imported by library-demo.bundle.js, so it needs its own
// bundle — by hand, what a real consumer's bundler (Vite, webpack) would
// do automatically by recognizing `new Worker(new URL(...))` and splitting
// it into its own chunk (ARCHITECTURE.md section 4). Constructing a Worker
// at all requires a real HTTP origin — confirmed by hand in a real
// browser, file:// pages get an opaque origin and every Worker
// construction throws immediately, classic or module — so unlike the
// bundle above, this one only ever runs served over http(s). See
// demo/README.md and DECISIONS.md.
await esbuild.build({
  entryPoints: ["src/engine/occt.worker.ts"],
  outfile: "demo/occt.worker.bundle.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info",
  platform: "browser",
  // occt-import-js's glue code has a Node-only branch (`if
  // (ENVIRONMENT_IS_NODE) { require("fs"); require("path"); ... }`) that
  // never runs in a browser worker, but esbuild still tries to statically
  // resolve every require() call regardless of which runtime branch reaches
  // it, and fails outright since "fs"/"path" don't exist for a browser
  // target. Marking them external tells esbuild to leave those calls
  // exactly as written rather than resolving them — safe, because they are
  // genuinely unreachable dead code here.
  external: ["fs", "path"],
});

// solidworks.worker.ts's own dependencies (SolidWorksDecodeEngine, pako) are
// pure JS with no Node-only branch to exclude, unlike occt.worker.ts above —
// so this bundle needs no `external` list, and there's no wasm binary to
// copy afterward either.
await esbuild.build({
  entryPoints: ["src/engine/solidworks.worker.ts"],
  outfile: "demo/solidworks.worker.bundle.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info",
  platform: "browser",
});

// dxf.worker.ts's own dependency (DxfDecodeEngine) is pure JS with no
// external package and no Node-only branch, same as solidworks.worker.ts
// above — no `external` list, no binary to copy afterward.
await esbuild.build({
  entryPoints: ["src/engine/dxf.worker.ts"],
  outfile: "demo/dxf.worker.bundle.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info",
  platform: "browser",
});

// The OCCT wasm binary itself is never statically imported — the demo
// passes WasmAssetAccessor a URL and it's fetched at runtime — so it only
// needs to exist next to the demo, not be bundled. Copied rather than
// gitignored: committing it (with its LGPL license texts, both below) is
// what keeps the demo working immediately after a fresh clone, the same
// reason library-demo.bundle.js is committed rather than regenerated
// on demand.
await copyFile(
  "node_modules/occt-import-js/dist/occt-import-js.wasm",
  "demo/occt-import-js.wasm",
);
await copyFile(
  "node_modules/occt-import-js/dist/license.occt-import-js.txt",
  "demo/license.occt-import-js.txt",
);
await copyFile(
  "node_modules/occt-import-js/dist/license.occt.txt",
  "demo/license.occt.txt",
);
