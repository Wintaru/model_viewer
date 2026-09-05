// Bundles demo/library-demo.ts (source, plus everything it imports from
// src/) into demo/library-demo.bundle.js: one classic <script> file with no
// import statements left in it, so it loads over file:// like demo/viewer.html
// does. esbuild's JS API is used directly rather than its CLI — pnpm's
// generated node_modules/.bin/esbuild shim assumes esbuild's own bin/esbuild
// file is a Node script it can run via `node <path>`, but esbuild ships that
// file as the native binary itself, so the shim crashes trying to `require()`
// a Mach-O executable. The JS API resolves the real binary correctly and
// isn't affected. See DECISIONS.md.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["demo/library-demo.ts"],
  outfile: "demo/library-demo.bundle.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
