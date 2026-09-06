import type { DecodedMesh } from "../common/DecodedMesh";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import { extractModernContainerChunks } from "../utility/SolidWorksContainerUtil";

const TESS_DATA_MAGIC = "TessData";

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
 * generalizes across them, not a name allowlist.
 */
export function extractTessDataStreams(
  fileBytes: Uint8Array,
): readonly Uint8Array[] {
  const withMagic = extractModernContainerChunks(fileBytes)
    .map((chunk) => chunk.data)
    .filter((data) => containsAscii(data, TESS_DATA_MAGIC));
  return dedupeByBytes(withMagic);
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
const UNIT_NORMAL_TOLERANCE = 0.05;
const MIN_UNIT_NORMAL_RATIO = 0.8;

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
    normalParts.push(block.normals);

    let stripBase = vertexBase;
    for (const stripSize of block.stripSizes) {
      for (let k = 0; k < stripSize - 2; k++) {
        indices.push(
          ...(k % 2 === 0
            ? [stripBase + k, stripBase + k + 1, stripBase + k + 2]
            : [stripBase + k + 1, stripBase + k, stripBase + k + 2]),
        );
      }
      stripBase += stripSize;
    }
    vertexBase += block.positions.length / FLOATS_PER_VERTEX;
  }

  return {
    positions: concatFloat32(positionParts),
    normals: concatFloat32(normalParts),
    indices: Uint32Array.from(indices),
  };
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
  for (let word = tailStartWord; word < searchEnd; word++) {
    if (readU32(view, align + word * BYTES_PER_WORD) === total) {
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
 * 1, matching `research/d9-decode.py`'s own tolerance for the occasional
 * genuinely-non-unit normal real tessellators emit.
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
 * SLDASM (assemblies) are untested — WAYFINDER.md's D9 follow-up — so this
 * is scoped to parts, matching SPEC.md section 10's own slice-3 ordering.
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
