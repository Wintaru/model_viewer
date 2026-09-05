// D8 step 1 — ground truth.
// For each NIST part, read its STEP twin and record triangle count and
// bounding box. The SLDPRT files hold the SAME parts, so these numbers are
// the fingerprint we look for inside the SolidWorks container.
import occtimportjs from 'occt-import-js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP_DIR = new URL('../assets/step/', import.meta.url).pathname;
const occt = await occtimportjs();

// Part key -> the STEP variant to trust. Prefer the plain rb/rc/rd files:
// they are the smallest and parsed cleanest in the earlier probe.
const files = readdirSync(STEP_DIR).filter((f) => f.endsWith('.stp'));
const byPart = new Map();
for (const f of files) {
  const key = f.match(/^(nist_(?:ctc|ftc|stc)_\d+)/)?.[1];
  if (!key) continue;
  const rank = /_r[bcd]\.stp$/.test(f) ? 0 : /ap242/.test(f) ? 1 : 2;
  const prev = byPart.get(key);
  if (!prev || rank < prev.rank) byPart.set(key, { file: f, rank });
}

const truth = {};
for (const [part, { file }] of [...byPart].sort()) {
  const bytes = new Uint8Array(readFileSync(join(STEP_DIR, file)));
  let r;
  try {
    r = occt.ReadStepFile(bytes, null);
  } catch {
    continue;
  }
  if (!r.success || r.meshes.length === 0) continue;

  let tri = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let vertexCount = 0;
  for (const m of r.meshes) {
    tri += m.index.array.length / 3;
    const p = m.attributes.position.array;
    vertexCount += p.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < lo[a]) lo[a] = p[i + a];
        if (p[i + a] > hi[a]) hi[a] = p[i + a];
      }
    }
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  truth[part] = {
    stepFile: file,
    triangles: tri,
    vertices: vertexCount,
    min: lo.map((v) => +v.toFixed(4)),
    max: hi.map((v) => +v.toFixed(4)),
    size: size.map((v) => +v.toFixed(4)),
  };
  console.log(
    `${part.padEnd(14)} ${String(tri).padStart(6)} tri  ` +
      `${String(vertexCount).padStart(6)} vert  ` +
      `bbox ${size.map((v) => v.toFixed(1).padStart(7)).join(' x ')}  (${file})`
  );
}

writeFileSync(
  new URL('./d8-truth.json', import.meta.url).pathname,
  JSON.stringify(truth, null, 2)
);
console.log(`\nWrote ground truth for ${Object.keys(truth).length} parts.`);
