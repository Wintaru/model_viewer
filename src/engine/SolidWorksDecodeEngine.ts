import type { DecodedMesh } from "../common/DecodedMesh";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import { extractModernContainerChunks } from "../utility/SolidWorksContainerUtil";

const TESS_DATA_MAGIC = "TessData";
// An assembly's own `Contents/DisplayLists` chunk does carry the `TessData`
// substring (D14's content-sniff finds it), but only as part of unrelated
// display-state bookkeeping tags (`uoTempAssemblySHDData_c`, ...) -- it has
// no real "4, 8, 2, N" tessellation headers at all. A real assembly's
// per-component triangle data instead lives in one `FaceTessellations/<id>`
// chunk per component (DECISIONS.md D20), which carries no `TessData`
// substring of its own, so content-sniffing alone misses it entirely.
const FACE_TESSELLATIONS_PREFIX = "FaceTessellations/";

/**
 * Recovers every stream holding SolidWorks's cached tessellation, from a
 * SLDPRT/SLDASM file's raw bytes. WAYFINDER.md's D12/D13/D14: this used to
 * be a blind brute-force scan (trying a decompression at every byte offset,
 * recursively) — replaced once D14 found and validated the real container
 * structure `SolidWorksContainerUtil.ts` now reads directly. Real
 * measurement, not a guess: the brute-force version took 45-60 seconds per
 * NIST part and could run for several minutes or hang outright on a
 * SolidWorks drawing (DECISIONS.md); this version finds the same stream in
 * 2-95 milliseconds, across every real file checked so far — SLDPRT, SLDASM,
 * and SLDDRW alike, unmodified.
 *
 * Filtering by the literal `TessData` substring (rather than trusting a
 * specific chunk name like `Contents/DisplayLists` or `Contents/VBLists`)
 * is deliberate, not a leftover from the old scan: different SolidWorks
 * document types were found to use different chunk names for the same
 * cached-mesh content (D14), so content-sniffing is what actually
 * generalizes across them, not a name allowlist. That still isn't the whole
 * story for assemblies, though (D20): a real component's tessellation lives
 * under a `FaceTessellations/<id>` chunk name that carries no `TessData`
 * substring of its own, so those are matched by name prefix instead —
 * a chunk with no valid tessellation block inside it (like the sibling
 * `FaceTessellations/Directory` index) simply decodes to zero triangles
 * downstream, exactly like any other candidate stream that turns out empty.
 */
export function extractTessDataStreams(
  fileBytes: Uint8Array,
): readonly Uint8Array[] {
  const matching = extractModernContainerChunks(fileBytes).filter(
    (chunk) =>
      containsAscii(chunk.data, TESS_DATA_MAGIC) ||
      chunk.name.startsWith(FACE_TESSELLATIONS_PREFIX),
  );
  return dedupeByBytes(matching.map((chunk) => chunk.data));
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  for (let start = 0; start <= bytes.length - text.length; start++) {
    if (matchesAsciiAt(bytes, start, text)) {
      return true;
    }
  }
  return false;
}

function matchesAsciiAt(
  bytes: Uint8Array,
  start: number,
  text: string,
): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function dedupeByBytes(streams: readonly Uint8Array[]): readonly Uint8Array[] {
  const unique: Uint8Array[] = [];
  for (const stream of streams) {
    if (!unique.some((seen) => bytesEqual(seen, stream))) {
      unique.push(stream);
    }
  }
  return unique;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// --- Tessellation block decode -------------------------------------------
//
// Ports `decode_stream`/`_scan` from research/d9-decode.py: given one stream
// already recovered by extractTessDataStreams above, finds every
// tessellation block inside it and assembles them into one mesh.
//
// Record layout (ARCHITECTURE.md section 6):
//   u32  4, 8, 2, N          marker, N = number of triangle strips
//   u32  size[0..N-1]        vertices per strip, summing to TOTAL
//   u32  a, b, 2, TOTAL      tail, ending with the vertex total
//   f32  TOTAL * 3           vertex positions, metres
//   f32  TOTAL * 3           per-vertex normals

const TESSELLATION_HEADER_MARKER = [4, 8, 2];
const MAX_LOOPS = 20_000;
const MIN_STRIP_SIZE = 3;
const MAX_STRIP_SIZE = 100_000;
const TAIL_SEARCH_WINDOW_WORDS = 8;
const BYTE_ALIGNMENTS_TO_SCAN = 4;
const BYTES_PER_WORD = 4;
const FLOATS_PER_VERTEX = 3;
const MAX_ABS_POSITION_METRES = 100.0;
const MIN_NORMAL_LENGTH = 1e-9;
const UNIT_NORMAL_TOLERANCE = 0.5;
const MIN_UNIT_NORMAL_RATIO = 0.8;
// sin(angle) between a triangle's two edge vectors, below which it counts
// as degenerate. Scale-relative (unlike a raw cross-product-magnitude
// check) so it classifies consistently whether positions are metres or
// millimetres, and so float32 rounding noise on an otherwise-collinear
// triple of points can't manufacture a spurious "real" direction out of
// pure noise.
const DEGENERATE_TRIANGLE_SIN_THRESHOLD = 1e-4;
// Vertices closer than this (metres) are treated as the same real point,
// so a shared edge between two strips reads as one edge, not two
// coincidentally-nearby ones -- roughly a micron, comfortably above
// float32 rounding noise and comfortably below any real, distinct feature.
const WELD_DECIMAL_PLACES = 6;
// The standard "smoothing angle" every 3D/CAD tool exposes for exactly
// this decision (Blender's Shade Auto Smooth, 3ds Max smoothing groups,
// MeshLab's normal estimation, ...): blend across an edge whose two faces
// differ by less than this (a fine tessellation of a real curve), keep a
// hard edge otherwise (a genuine part edge, like a sheet-metal bend).
// Chosen from measurement, not a round-number guess: a real customer
// part's actual shared-edge dihedral angles cluster tightly under 30
// degrees (fillets, hole walls) or over 90 (real bends), with zero edges
// measured anywhere in between (DECISIONS.md) -- 45 sits in the middle of
// that empty gap, so the exact value carries a wide safety margin.
const CREASE_ANGLE_DEGREES = 45;
const CREASE_ANGLE_MIN_COS = Math.cos((CREASE_ANGLE_DEGREES * Math.PI) / 180);

export interface SolidWorksMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

interface TessellationBlock {
  readonly start: number;
  readonly end: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly stripSizes: readonly number[];
}

/**
 * Decodes every tessellation block found in one already-extracted TessData
 * stream into a single mesh. Headers are not always word-aligned within the
 * stream (ARCHITECTURE.md section 6, point 2), so every one of the 4 byte
 * alignments is scanned independently; the same block can then be found more
 * than once, at more than one alignment, so overlapping candidates are
 * resolved before assembly — preferring the larger block, matching
 * `research/d9-decode.py`'s own reasoning that a coincidental match is
 * usually small.
 */
export function decodeTessDataStream(stream: Uint8Array): SolidWorksMesh {
  const candidates: TessellationBlock[] = [];
  for (let align = 0; align < BYTE_ALIGNMENTS_TO_SCAN; align++) {
    candidates.push(...scanAlignment(stream, align));
  }
  const kept = keepNonOverlapping(candidates);
  kept.sort((a, b) => a.start - b.start);
  return assembleMesh(kept);
}

function blockByteSize(block: TessellationBlock): number {
  return block.end - block.start;
}

function keepNonOverlapping(
  candidates: readonly TessellationBlock[],
): TessellationBlock[] {
  const bySizeDescending = [...candidates].sort(
    (a, b) => blockByteSize(b) - blockByteSize(a),
  );
  const kept: TessellationBlock[] = [];
  for (const candidate of bySizeDescending) {
    const overlapsKept = kept.some(
      (k) => candidate.start < k.end && k.start < candidate.end,
    );
    if (!overlapsKept) {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * Builds triangle **strips**, not fans — ARCHITECTURE.md section 6's first
 * warning. Fanning a run from its first vertex collapses a cylindrical hole
 * wall onto a point; a strip alternates winding direction every other
 * triangle instead.
 */
function assembleMesh(kept: readonly TessellationBlock[]): SolidWorksMesh {
  const positionParts: Float32Array[] = [];
  const normalParts: Float32Array[] = [];
  const indices: number[] = [];
  let vertexBase = 0;

  for (const block of kept) {
    positionParts.push(block.positions);
    normalParts.push(
      synthesizeSmoothedNormals(block.positions, block.stripSizes),
    );

    for (const [a, b, c] of buildStripTriangles(block.stripSizes)) {
      indices.push(vertexBase + a, vertexBase + b, vertexBase + c);
    }
    vertexBase += block.positions.length / FLOATS_PER_VERTEX;
  }

  return {
    positions: concatFloat32(positionParts),
    normals: concatFloat32(normalParts),
    indices: Uint32Array.from(indices),
  };
}

/** One triangle strip's triangles, as local (block-relative) vertex-index
 * triples — the shared winding rule every consumer of a strip needs
 * (ARCHITECTURE.md section 6's first warning: strips, not fans). */
function buildStripTriangles(
  stripSizes: readonly number[],
): Array<readonly [number, number, number]> {
  const triangles: Array<readonly [number, number, number]> = [];
  let base = 0;
  for (const stripSize of stripSizes) {
    for (let k = 0; k < stripSize - 2; k++) {
      triangles.push(
        k % 2 === 0
          ? [base + k, base + k + 1, base + k + 2]
          : [base + k + 1, base + k, base + k + 2],
      );
    }
    base += stripSize;
  }
  return triangles;
}

/**
 * Recomputes every vertex normal for one tessellation block directly from
 * its own decoded triangle geometry — SolidWorks's own stored per-vertex
 * normals are never read here. Measured across a real customer part
 * (DECISIONS.md): those stored values carry at least two distinct,
 * unrelated defects (a strip's leading vertex stored as exactly zero-
 * length; other vertices carrying a real but *wrong* unit-length normal,
 * borrowed from a different, connected face) — trying to detect and patch
 * each defect in place kept finding a next one, and a narrow per-vertex
 * "is my own immediate neighbourhood flat" check even *introduced* a third
 * defect (flattening genuinely curved surfaces it had no way to tell apart
 * from a truly flat one, one vertex at a time). Discarding the stored
 * values entirely and regenerating them the way every mesh tool does —
 * real per-face geometry, blended across an edge only when the two faces
 * meeting there are close to continuous, kept crisp otherwise — sidesteps
 * the whole class of "is this specific stored value trustworthy" question,
 * because it never depends on the answer.
 *
 * Welds vertices by position **within this block only**, never across
 * two different blocks even where they meet at a real, continuous edge:
 * measured on the more complex NIST calibration parts (DECISIONS.md),
 * welding globally let an unrelated, non-adjacent block's vertex —
 * coincidentally sharing a welded position, or chained in transitively
 * through some other gentle edge — drag a genuinely flat block's own
 * vertex normal towards a completely different face. Scoping welding to
 * one block trades away smoothing across a curve SolidWorks happened to
 * split into two blocks, in exchange for never mixing unrelated
 * geometry — validated against the real customer part and the whole NIST
 * corpus (12 real files, 392 to 30,632 vertices): every block SolidWorks's
 * own tessellation is internally flat comes back perfectly consistent,
 * zero exceptions.
 */
function synthesizeSmoothedNormals(
  positions: Float32Array,
  stripSizes: readonly number[],
): Float32Array {
  const vertexCount = positions.length / FLOATS_PER_VERTEX;
  const triangles = buildStripTriangles(stripSizes);
  const weldGroupOf = weldPositionsWithinBlock(positions);
  const faceNormals = triangles.map(([a, b, c]) =>
    triangleNormal(positions, a, b, c),
  );
  const smoothingGroupOfTriangle = groupTrianglesByCreaseAngle(
    triangles,
    faceNormals,
    weldGroupOf,
  );
  return averageNormalsPerWeldedSmoothingGroup(
    vertexCount,
    triangles,
    faceNormals,
    weldGroupOf,
    smoothingGroupOfTriangle,
  );
}

/** Assigns every vertex a group id shared with every other vertex in this
 * same block sitting at (nearly) the same real-world position. */
function weldPositionsWithinBlock(positions: Float32Array): Uint32Array {
  const vertexCount = positions.length / FLOATS_PER_VERTEX;
  const groupIdByKey = new Map<string, number>();
  const groupOf = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const x = (positions[v * 3] ?? 0).toFixed(WELD_DECIMAL_PLACES);
    const y = (positions[v * 3 + 1] ?? 0).toFixed(WELD_DECIMAL_PLACES);
    const z = (positions[v * 3 + 2] ?? 0).toFixed(WELD_DECIMAL_PLACES);
    const key = `${x},${y},${z}`;
    let group = groupIdByKey.get(key);
    if (group === undefined) {
      group = groupIdByKey.size;
      groupIdByKey.set(key, group);
    }
    groupOf[v] = group;
  }
  return groupOf;
}

/**
 * Union-find over triangles: two triangles sharing a welded edge join the
 * same smoothing group whenever the angle between their own real geometric
 * normals is gentle (`CREASE_ANGLE_DEGREES`) — a fine tessellation of a
 * real curve — and stay separate when it's sharp — a genuine part edge.
 * Returns each triangle's group as its union-find root.
 */
function groupTrianglesByCreaseAngle(
  triangles: ReadonlyArray<readonly [number, number, number]>,
  faceNormals: ReadonlyArray<readonly [number, number, number] | undefined>,
  weldGroupOf: Uint32Array,
): Uint32Array {
  const parent = Uint32Array.from({ length: triangles.length }, (_, i) => i);
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    let current = start;
    while (current !== root) {
      const next = parent[current] ?? root;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootA] = rootB;
    }
  };

  const trianglesByWeldedEdge = new Map<string, number[]>();
  triangles.forEach(([a, b, c], triangleIndex) => {
    if (faceNormals[triangleIndex] === undefined) {
      return;
    }
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = weldedEdgeKey(weldGroupOf[x] ?? 0, weldGroupOf[y] ?? 0);
      const sharing = trianglesByWeldedEdge.get(key);
      if (sharing) {
        sharing.push(triangleIndex);
      } else {
        trianglesByWeldedEdge.set(key, [triangleIndex]);
      }
    }
  });

  for (const sharingThisEdge of trianglesByWeldedEdge.values()) {
    for (let i = 0; i < sharingThisEdge.length; i++) {
      for (let j = i + 1; j < sharingThisEdge.length; j++) {
        const first = faceNormals[sharingThisEdge[i] ?? 0];
        const second = faceNormals[sharingThisEdge[j] ?? 0];
        if (
          first !== undefined &&
          second !== undefined &&
          dotProduct(normalize(first), normalize(second)) >=
            CREASE_ANGLE_MIN_COS
        ) {
          union(sharingThisEdge[i] ?? 0, sharingThisEdge[j] ?? 0);
        }
      }
    }
  }

  return Uint32Array.from(triangles, (_, t) => find(t));
}

function weldedEdgeKey(groupA: number, groupB: number): string {
  return groupA < groupB ? `${groupA}:${groupB}` : `${groupB}:${groupA}`;
}

/**
 * Each vertex's final normal is the area-weighted average of the face
 * normals of every triangle in its own smoothing group that touches its
 * exact (welded) position — so two different literal vertices at a real
 * shared edge, blended together, come out with exactly the same value,
 * while a vertex touched by no non-degenerate triangle at all is left at
 * (0,0,0) rather than guessing.
 */
function averageNormalsPerWeldedSmoothingGroup(
  vertexCount: number,
  triangles: ReadonlyArray<readonly [number, number, number]>,
  faceNormals: ReadonlyArray<readonly [number, number, number] | undefined>,
  weldGroupOf: Uint32Array,
  smoothingGroupOfTriangle: Uint32Array,
): Float32Array {
  const sumByKey = new Map<string, [number, number, number]>();
  const touchingTriangles: number[][] = Array.from(
    { length: vertexCount },
    () => [],
  );
  triangles.forEach(([a, b, c], triangleIndex) => {
    const face = faceNormals[triangleIndex];
    if (face === undefined) {
      return;
    }
    const smoothingGroup = smoothingGroupOfTriangle[triangleIndex] ?? 0;
    for (const vertex of [a, b, c]) {
      touchingTriangles[vertex]?.push(triangleIndex);
      const key = `${weldGroupOf[vertex] ?? 0}:${smoothingGroup}`;
      const sum = sumByKey.get(key) ?? [0, 0, 0];
      sum[0] += face[0];
      sum[1] += face[1];
      sum[2] += face[2];
      sumByKey.set(key, sum);
    }
  });

  const normals = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const touching = touchingTriangles[vertex];
    if (touching === undefined || touching.length === 0) {
      continue; // No non-degenerate triangle touches this vertex; leave it.
    }
    const smoothingGroup = mostCommonSmoothingGroup(
      touching,
      smoothingGroupOfTriangle,
    );
    const sum = sumByKey.get(`${weldGroupOf[vertex] ?? 0}:${smoothingGroup}`);
    if (sum === undefined) {
      continue;
    }
    const length = Math.sqrt(sum[0] ** 2 + sum[1] ** 2 + sum[2] ** 2);
    if (length < MIN_NORMAL_LENGTH) {
      continue;
    }
    normals[vertex * 3] = sum[0] / length;
    normals[vertex * 3 + 1] = sum[1] / length;
    normals[vertex * 3 + 2] = sum[2] / length;
  }
  return normals;
}

/** Which smoothing group a vertex's own touching triangles belong to —
 * almost always unanimous; the rare disagreement (a genuine corner) breaks
 * by majority rather than crashing or picking arbitrarily. */
function mostCommonSmoothingGroup(
  triangleIndices: readonly number[],
  smoothingGroupOfTriangle: Uint32Array,
): number {
  const counts = new Map<number, number>();
  let best = smoothingGroupOfTriangle[triangleIndices[0] ?? 0] ?? 0;
  let bestCount = 0;
  for (const triangleIndex of triangleIndices) {
    const group = smoothingGroupOfTriangle[triangleIndex] ?? 0;
    const count = (counts.get(group) ?? 0) + 1;
    counts.set(group, count);
    if (count > bestCount) {
      bestCount = count;
      best = group;
    }
  }
  return best;
}

function normalize(
  v: readonly [number, number, number],
): readonly [number, number, number] {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return length < MIN_NORMAL_LENGTH
    ? v
    : [v[0] / length, v[1] / length, v[2] / length];
}

function dotProduct(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The real, outward-consistent face normal for one triangle (unnormalized —
 * its own magnitude is proportional to twice the triangle's area, used as
 * an area weight when averaging several triangles together), using its
 * vertices in exactly the order callers already store them — that order
 * already encodes the correct winding (validated throughout this file's
 * own tests), so no separate sign correction is needed here, unlike a
 * boundary fan built from scratch.
 */
function triangleNormal(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): readonly [number, number, number] | undefined {
  const ax = positions[a * 3] ?? 0;
  const ay = positions[a * 3 + 1] ?? 0;
  const az = positions[a * 3 + 2] ?? 0;
  const bx = positions[b * 3] ?? 0;
  const by = positions[b * 3 + 1] ?? 0;
  const bz = positions[b * 3 + 2] ?? 0;
  const cx = positions[c * 3] ?? 0;
  const cy = positions[c * 3 + 1] ?? 0;
  const cz = positions[c * 3 + 2] ?? 0;
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const uLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const vLength = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (uLength < MIN_NORMAL_LENGTH || vLength < MIN_NORMAL_LENGTH) {
    return undefined; // Duplicate points -- no edge to take a normal from.
  }
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const crossLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (crossLength / (uLength * vLength) < DEGENERATE_TRIANGLE_SIN_THRESHOLD) {
    return undefined; // Degenerate: the two edges are collinear.
  }
  return [nx, ny, nz];
}

function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function scanAlignment(stream: Uint8Array, align: number): TessellationBlock[] {
  // One view over the whole stream; every read below adds `align` to its
  // word offset, so word 0 here means byte `align`, not byte 0 — this is
  // what makes "scan at 4 alignments" mean anything: the same bytes get
  // reinterpreted as u32/f32 starting 0, 1, 2, or 3 bytes later.
  const view = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  );
  const wordCount = Math.floor((stream.byteLength - align) / BYTES_PER_WORD);
  if (wordCount < TAIL_SEARCH_WINDOW_WORDS * 2) {
    // Too short to hold even an empty header plus a tail search window —
    // nothing to find at this alignment.
    return [];
  }

  const blocks: TessellationBlock[] = [];
  let word = 0;
  while (word < wordCount - TAIL_SEARCH_WINDOW_WORDS) {
    // Step 1: does a header start here? The literal "4, 8, 2" marker is
    // load-bearing (ARCHITECTURE.md section 6) — matching on shape alone
    // (a count, then sizes, then their sum) fires on far more coincidental
    // data than real headers.
    const headerByte = align + word * BYTES_PER_WORD;
    if (!matchesHeaderMarker(view, headerByte)) {
      word += 1;
      continue;
    }

    // Step 2: read N (the strip count) and sanity-check it before trusting
    // it as a length — a bogus N here would make every later read run off
    // the end of the buffer or read garbage as if it were real strip sizes.
    const loopCount = readU32(view, headerByte + 3 * BYTES_PER_WORD);
    const sizesStartWord = word + 4;
    if (
      loopCount < 1 ||
      loopCount > MAX_LOOPS ||
      sizesStartWord + loopCount + 4 > wordCount
    ) {
      word += 1;
      continue;
    }

    // Step 3: read the N strip sizes themselves, each bounds-checked
    // (3..100000 vertices — a real triangle strip can't be shorter than a
    // single triangle, and 100000 is already an implausibly long one).
    const stripSizes = readStripSizes(view, align, sizesStartWord, loopCount);
    if (stripSizes === undefined) {
      word += 1;
      continue;
    }
    const total = stripSizes.reduce((sum, size) => sum + size, 0);

    // Step 4: confirm this is a real header, not a coincidence, by finding
    // the vertex total (the sum just computed) restated a few words later
    // in the tail. `dataStartWord` is where the actual float data begins,
    // right after that confirming word.
    const tailStartWord = sizesStartWord + loopCount;
    const dataStartWord = findWordAfterTotalMarker(
      view,
      align,
      tailStartWord,
      wordCount,
      total,
    );
    if (dataStartWord === undefined) {
      word += 1;
      continue;
    }

    // Step 5: there must be room left in the buffer for TOTAL vertices'
    // worth of positions *and* the same number of normals right after.
    const floatsNeeded = total * FLOATS_PER_VERTEX;
    if (dataStartWord + floatsNeeded * 2 > wordCount) {
      word += 1;
      continue;
    }

    // Step 6: read the positions and reject the block if they don't look
    // like real coordinates (NaN, or absurdly far from the origin) — a
    // false-positive header often decodes into exactly this kind of noise.
    const positions = readFloats(view, align, dataStartWord, floatsNeeded);
    if (!positionsLookValid(positions)) {
      word += 1;
      continue;
    }
    // Step 7: same idea for the normals, which sit right after the
    // positions — but the tell here is length, not range: a small integer
    // misread as float32 can look like a plausible position yet will
    // essentially never have unit length as a normal.
    const normals = readFloats(
      view,
      align,
      dataStartWord + floatsNeeded,
      floatsNeeded,
    );
    if (!normalsLookValid(normals)) {
      word += 1;
      continue;
    }

    // Step 8: everything checked out — record this block's absolute byte
    // span (needed later to discard overlapping candidates found at other
    // alignments) and resume scanning right after it, rather than at the
    // very next word.
    const endWord = dataStartWord + floatsNeeded * 2;
    blocks.push({
      start: headerByte,
      end: align + endWord * BYTES_PER_WORD,
      positions,
      normals,
      stripSizes,
    });
    word = endWord;
  }
  return blocks;
}

function matchesHeaderMarker(view: DataView, headerByte: number): boolean {
  return TESSELLATION_HEADER_MARKER.every(
    (expected, i) =>
      readU32(view, headerByte + i * BYTES_PER_WORD) === expected,
  );
}

function readStripSizes(
  view: DataView,
  align: number,
  startWord: number,
  count: number,
): number[] | undefined {
  const sizes: number[] = [];
  for (let k = 0; k < count; k++) {
    const size = readU32(view, align + (startWord + k) * BYTES_PER_WORD);
    if (size < MIN_STRIP_SIZE || size > MAX_STRIP_SIZE) {
      return undefined;
    }
    sizes.push(size);
  }
  return sizes;
}

/**
 * The tail ends with the vertex total, found within a few words of the
 * strip-size list rather than immediately after it. Returns the word index
 * right after the matching one — where the position floats begin.
 *
 * The literal `2` immediately before `total` is load-bearing, not optional
 * (the tail layout is `a, b, 2, TOTAL`) — matching on `total` alone finds
 * the wrong word whenever a block's own vertex count happens to equal `a`,
 * the tail's leading constant word (observed value `12`, on a real
 * customer part where three small blocks each tessellated to exactly 12
 * vertices). That silently shifted `dataStartWord` three words early, so
 * every position/normal float read for that block came from the wrong
 * bytes — still valid-looking on their own (real coordinates, near-unit
 * normals) but numerically wrong, corrupting that block's winding and
 * geometry without tripping any other check (DECISIONS.md).
 */
function findWordAfterTotalMarker(
  view: DataView,
  align: number,
  tailStartWord: number,
  wordCount: number,
  total: number,
): number | undefined {
  const searchEnd = Math.min(
    tailStartWord + TAIL_SEARCH_WINDOW_WORDS,
    wordCount,
  );
  for (let word = tailStartWord + 1; word < searchEnd; word++) {
    const precededByLiteralTwo =
      readU32(view, align + (word - 1) * BYTES_PER_WORD) === 2;
    if (
      precededByLiteralTwo &&
      readU32(view, align + word * BYTES_PER_WORD) === total
    ) {
      return word + 1;
    }
  }
  return undefined;
}

function readFloats(
  view: DataView,
  align: number,
  startWord: number,
  count: number,
): Float32Array {
  const floats = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    floats[k] = readF32(view, align + (startWord + k) * BYTES_PER_WORD);
  }
  return floats;
}

/** No `NaN`, and no coordinate implausibly far from the origin. */
function positionsLookValid(positions: Float32Array): boolean {
  for (const value of positions) {
    if (Number.isNaN(value) || Math.abs(value) > MAX_ABS_POSITION_METRES) {
      return false;
    }
  }
  return true;
}

/**
 * A small integer read as `float32` looks like a plausible position (7 is a
 * denormal near 1e-44, which the check above lets through) but never has
 * unit length as a normal — ARCHITECTURE.md section 6's third warning. Most,
 * not all, non-zero normals must be within `UNIT_NORMAL_TOLERANCE` of length
 * 1, matching `research/d9-decode.py`'s own tolerance.
 *
 * `UNIT_NORMAL_TOLERANCE` was originally 0.05, on the assumption that a
 * genuinely-non-unit normal is rare. Measured wrong, not just tight: a real
 * customer part's small tessellation strip along a filleted bend (radiused
 * per its drawing) had only 14 of 26 normals within 0.05 of unit length —
 * roughly half, not "occasional" — so the whole strip was silently dropped,
 * leaving a real gap in the decoded surface (DECISIONS.md). The bad-length
 * values themselves clustered tightly around 1 (0.66-1.21, from smoothly
 * blended/interpolated normals along the curve), nothing like the wildly
 * divergent or NaN lengths a coincidental byte-pattern match produces — so
 * 0.5 was chosen as comfortable margin around real measured data, not a
 * round number. Verified against the whole NIST corpus, not just this one
 * file: `MIN_UNIT_NORMAL_RATIO`'s 80% bar still does the real anti-garbage
 * work (unchanged), and every file that passed the STEP-bounding-box check
 * before this change still does — one more (`nist_ftc_11`) now does too.
 */
function normalsLookValid(normals: Float32Array): boolean {
  let nonZeroCount = 0;
  let unitLengthCount = 0;
  // Streams three components at a time without indexing into `normals`
  // (`for...of` over a typed array yields plain `number`s, sidestepping
  // `noUncheckedIndexedAccess` entirely for a length that's always a
  // multiple of FLOATS_PER_VERTEX by construction — see readFloats).
  let component = 0;
  let x = 0;
  let y = 0;
  for (const value of normals) {
    if (component === 0) {
      x = value;
    } else if (component === 1) {
      y = value;
    } else {
      const z = value;
      const length = Math.sqrt(x * x + y * y + z * z);
      if (length > MIN_NORMAL_LENGTH) {
        nonZeroCount += 1;
        if (Math.abs(length - 1.0) < UNIT_NORMAL_TOLERANCE) {
          unitLengthCount += 1;
        }
      }
    }
    component = (component + 1) % FLOATS_PER_VERTEX;
  }
  return (
    nonZeroCount > 0 && unitLengthCount / nonZeroCount >= MIN_UNIT_NORMAL_RATIO
  );
}

function readU32(view: DataView, byteOffset: number): number {
  return view.getUint32(byteOffset, true);
}

function readF32(view: DataView, byteOffset: number): number {
  return view.getFloat32(byteOffset, true);
}

// --- Assembly: transform() -------------------------------------------------
//
// Wires extractTessDataStreams and decodeTessDataStream together into the
// public Engine surface, ARCHITECTURE.md section 6. SolidWorks itself works
// in metres (FINDINGS.md section 5); DecodedModel.units is always 'mm', so
// positions are scaled on the way out — normals are directions, not
// distances, and stay as-is.

const METRES_TO_MILLIMETRES = 1000;

/**
 * Bytes to a {@link DecodedModel} for a SolidWorks part (SLDPRT). No wasm,
 * no Accessor, nothing to await — unlike `OcctDecodeEngine`, `transform` is
 * synchronous, the same shape `MeshDecodeEngine` already uses for the same
 * reason.
 *
 * `extractTessDataStreams` and `decodeTessDataStream` above stay exported in
 * their own right rather than becoming private helpers once this class
 * wraps them — unlike, say, `OcctDecodeEngine`'s small mapping functions,
 * each is a substantial, independently-verified port of one whole function
 * from `research/d9-decode.py`, with its own dedicated tests that would
 * otherwise lose precision (a failure would only say "transform() is wrong
 * somewhere," not which stage). See DECISIONS.md.
 *
 * SLDASM (assemblies) now decode too (WAYFINDER.md's D20), but far more
 * narrowly than parts: verified against exactly one real, single-component
 * assembly. Multi-component assemblies, nested sub-assemblies, and
 * suppressed components are all unverified — in particular, a real
 * assembly with two identical component instances (the same screw used
 * twice) could plausibly produce two byte-identical `FaceTessellations/*`
 * chunks that `dedupeByBytes` above would then collapse into one, silently
 * dropping one instance's geometry. Nothing currently distinguishes that
 * case from the legitimate two-different-names-one-real-stream case
 * content-based dedup exists for (see `extractTessDataStreams`'s own
 * comment) — resolving it needs a real multi-component file to check
 * against, not a guess.
 */
export class SolidWorksDecodeEngine {
  transform(bytes: Uint8Array): DecodedModel {
    const streams = extractTessDataStreams(bytes);
    if (streams.length === 0) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "no-tessdata-found",
        message:
          "No SolidWorks tessellation cache found in this file — this may be an older (pre-2014) container generation, which this version doesn't support. See ARCHITECTURE.md section 6.",
      });
    }

    const combined = combineTessDataStreams(streams);
    if (combined.indices.length === 0) {
      // Measured to matter: REVIEW-BACKLOG.md's D9 follow-ups note real
      // NIST parts exist where the cache holds only PMI annotation geometry
      // or otherwise fails to decode a usable block — this must say so,
      // not return an empty model claiming success (ARCHITECTURE.md
      // section 7's own reasoning for OcctDecodeEngine's diagnostics).
      return createEmptyDecodedModel({
        severity: "error",
        code: "tessdata-decode-failed",
        message:
          "Found a SolidWorks tessellation stream, but no valid tessellation block decoded from it.",
      });
    }

    const mesh: DecodedMesh = {
      positions: combined.positions.map((v) => v * METRES_TO_MILLIMETRES),
      normals: combined.normals,
      indices: combined.indices,
      // No CAD face identity: the tessellation cache is a flat list of
      // triangle strips with no per-face structure recovered, unlike
      // OCCT's brep_faces — SPEC.md section 6.
      faces: [],
    };

    return {
      units: "mm",
      meshes: [mesh],
      tree: [{ meshIndices: [0], children: [] }],
      metadata: {},
      diagnostics: [],
    };
  }
}

/**
 * Decodes every stream and concatenates the results into one mesh, matching
 * `research/d9-decode.py`'s own driver (`V, N, T = [], [], []; for blob in
 * uniq: ...`) — real NIST parts have exactly one TessData stream each
 * (verified in this port's own tests), but the algorithm doesn't assume
 * that.
 */
function combineTessDataStreams(
  streams: readonly Uint8Array[],
): SolidWorksMesh {
  const meshes = streams.map(decodeTessDataStream);
  const indices: number[] = [];
  let vertexBase = 0;
  for (const mesh of meshes) {
    for (const index of mesh.indices) {
      indices.push(vertexBase + index);
    }
    vertexBase += mesh.positions.length / FLOATS_PER_VERTEX;
  }
  return {
    positions: concatFloat32(meshes.map((mesh) => mesh.positions)),
    normals: concatFloat32(meshes.map((mesh) => mesh.normals)),
    indices: Uint32Array.from(indices),
  };
}
