// Imports the compiled dist/ the way a consumer does, and fails loudly if it
// cannot be loaded. Everything else in this repo — vitest, and
// scripts/build-library-demo.mjs — reads src/ directly, so nothing else ever
// executes the files that actually ship.
//
// This exists because that gap produced a real defect. Before 1.0.0,
// `moduleResolution: "Bundler"` let source omit the file extension and tsc
// copied the specifier into dist/ unchanged, so `import('@wintaru/part-viewer')`
// failed for a consumer with "Cannot find module .../BufferSourceAccessor"
// while every check in this repo stayed green. See DECISIONS.md.
//
// tsconfig.json now uses NodeNext, so an extensionless relative import is a
// compile error rather than a runtime surprise. That guard covers the specifier
// form. This one covers what the compiler cannot see: that package.json's
// exports map points at files that exist, that they load under Node's own ESM
// loader, that the documented public names are really there, and that each
// worker file sits where its proxy's `new URL(...)` expects it.
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

const manifest = JSON.parse(
  await readFile(new URL("package.json", ROOT), "utf8"),
);

// The public names README.md documents, keyed by the exports-map subpath they
// are reached through. Every subpath in the map must appear here, so adding an
// entry point without saying what it exports fails this check rather than
// shipping unverified.
const EXPECTED_NAMES = {
  ".": [
    "ModelLoader",
    "ModelExporter",
    "ModuleRegistry",
    "fromBuffer",
    "fromFile",
    "fromResponse",
    "fromUrl",
  ],
  "./three": ["toThree"],
  "./2d": ["toThreeDrawing", "frameOrthographicCamera", "setLayerVisible"],
};

// Read from the manifest rather than restated here: a renamed subpath or a
// target pointing at a file that was never emitted is exactly the kind of
// mistake this script exists to catch, and it cannot catch it from a copy.
const ENTRY_POINTS = Object.entries(manifest.exports)
  .map(([subpath, target]) => ({
    subpath,
    target: typeof target === "string" ? target : target.default,
    types: typeof target === "string" ? undefined : target.types,
  }))
  // `./package.json` is exported so tooling can read the manifest. It is not
  // code, so there is nothing to import or to check for named exports.
  .filter((entry) => entry.target.endsWith(".js"));

// Each proxy loads its worker with `new Worker(new URL("./<name>", ...))`,
// which resolves against the emitted file rather than through the exports map,
// so tsc and Node's loader both stay silent when one is missing.
const WORKERS = [
  "engine/occt.worker.js",
  "engine/solidworks.worker.js",
  "engine/dxf.worker.js",
];

const failures = [];

for (const { subpath, target, types } of ENTRY_POINTS) {
  const expected = EXPECTED_NAMES[subpath];
  if (expected === undefined) {
    failures.push(
      `exports has "${subpath}", but this script does not say what it ` +
        `exports — add it to EXPECTED_NAMES`,
    );
    continue;
  }

  if (types !== undefined) {
    try {
      await access(new URL(types, ROOT));
    } catch {
      failures.push(`"${subpath}" types point at ${types}, which is missing`);
    }
  }

  let module;
  try {
    module = await import(new URL(target, ROOT).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(`"${subpath}" (${target}) does not import: ${reason}`);
    continue;
  }

  const missing = expected.filter((name) => !(name in module));
  if (missing.length > 0) {
    failures.push(`"${subpath}" does not export: ${missing.join(", ")}`);
  }
}

for (const subpath of Object.keys(EXPECTED_NAMES)) {
  if (!(subpath in manifest.exports)) {
    failures.push(
      `this script expects a "${subpath}" entry point, and package.json's ` +
        `exports map no longer has one`,
    );
  }
}

for (const worker of WORKERS) {
  try {
    await access(new URL(`dist/${worker}`, ROOT));
  } catch {
    failures.push(`${worker} is missing — its proxy cannot start a worker`);
  }
}

if (failures.length > 0) {
  console.error("dist/ is not publishable:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\nChecked ${fileURLToPath(new URL("dist/", ROOT))}`);
  console.error("Run `pnpm run build` first if dist/ is stale or absent.");
  process.exit(1);
}

console.log(
  `dist/ is publishable: ${ENTRY_POINTS.length} entry points import, ` +
    `${WORKERS.length} workers present.`,
);
