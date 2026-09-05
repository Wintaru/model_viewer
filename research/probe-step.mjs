// Feasibility probe: can occt-import-js (OCCT via WASM) read the real NIST
// AP242 test corpus, and what does it give us back?
import occtimportjs from "occt-import-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STEP_DIR = new URL("../assets/step/", import.meta.url).pathname;
const occt = await occtimportjs();

const files = readdirSync(STEP_DIR)
  .filter((f) => f.toLowerCase().endsWith(".stp"))
  .sort();
let ok = 0;
let failed = 0;
let totalTriangles = 0;
let totalMs = 0;

for (const name of files) {
  const bytes = new Uint8Array(readFileSync(join(STEP_DIR, name)));
  const started = performance.now();
  let result;
  try {
    result = occt.ReadStepFile(bytes, null);
  } catch (err) {
    console.log(`FAIL  ${name}  threw: ${err.message}`);
    failed++;
    continue;
  }
  const ms = performance.now() - started;

  if (!result.success) {
    console.log(`FAIL  ${name}  (importer returned success=false)`);
    failed++;
    continue;
  }

  const triangles = result.meshes.reduce(
    (sum, m) => sum + m.index.array.length / 3,
    0,
  );
  const named = result.meshes.filter((m) => m.name).length;
  const colored = result.meshes.filter(
    (m) => m.color || m.brep_faces?.some((f) => f.color),
  ).length;

  ok++;
  totalTriangles += triangles;
  totalMs += ms;
  console.log(
    `OK    ${name.padEnd(34)} ` +
      `${String(result.meshes.length).padStart(3)} mesh  ` +
      `${String(triangles).padStart(7)} tri  ` +
      `${named} named  ${colored} colored  ` +
      `${(bytes.length / 1024).toFixed(0).padStart(5)} KB in  ` +
      `${ms.toFixed(0).padStart(5)} ms`,
  );
}

console.log(
  `\n${ok}/${files.length} parsed, ${failed} failed | ` +
    `${totalTriangles.toLocaleString()} triangles total | ${totalMs.toFixed(0)} ms total`,
);

// Look at the shape of one result in detail — what metadata survives the import?
const sample = occt.ReadStepFile(
  new Uint8Array(readFileSync(join(STEP_DIR, files[0]))),
  null,
);
console.log("\n=== Result keys:", Object.keys(sample));
console.log(
  "=== Root node:",
  JSON.stringify(sample.root, null, 2).slice(0, 600),
);
console.log("=== Mesh[0] keys:", Object.keys(sample.meshes[0]));
console.log(
  "=== Mesh[0] attributes:",
  Object.keys(sample.meshes[0].attributes ?? {}),
);
console.log(
  "=== Mesh[0] brep_faces sample:",
  JSON.stringify(sample.meshes[0].brep_faces?.slice(0, 2)),
);
