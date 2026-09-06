import { tryInflateRaw, tryInflateZlib } from "../utility/InflateUtil";

const TESS_DATA_MAGIC = "TessData";
const MIN_ACCEPTED_OUTPUT_BYTES = 256;
// research/d9-decode.py's per-attempt cap (`o.decompress(mv[i:], 64 << 20)`).
const MAX_OUTPUT_BYTES_PER_ATTEMPT = 64 << 20;
// research/d9-decode.py's `MAX_TOTAL_INFLATED` — an aggregate cap across the
// whole recursive scan, so a file holding many small decompression bombs
// can't exhaust memory even though each one alone stays under the per-attempt
// cap above.
const MAX_TOTAL_INFLATED_BYTES = 512 << 20;
const MAX_RECURSION_DEPTH = 5;
const MIN_SCANNABLE_TAIL_BYTES = 8;

/**
 * Ports `collect`/`inflate_all` from `research/d9-decode.py`: recovers every
 * stream holding SolidWorks's cached tessellation, from a SLDPRT/SLDASM
 * file's raw bytes — no container parsing at all. FINDINGS.md section 5: the
 * geometry cache is just deflate blocks scattered through the file, some
 * nested inside others, found only by attempting decompression at every
 * offset and recursing into whatever inflates.
 *
 * Three deliberate differences from the Python original, all recorded in
 * DECISIONS.md:
 *
 * - **No skip-forward after a successful match.** Python advances past the
 *   compressed bytes it just consumed (`i += got[0]`), using
 *   `decompressobj().unused_data` to know how far. This port's `InflateUtil`
 *   only reports whether an attempt succeeded, not how many input bytes it
 *   consumed, so every offset is visited regardless. Measured by hand: even
 *   `research/d9-decode.py`'s own C-accelerated zlib takes 36s on a real NIST
 *   file's full recursive scan, and this port lands in the same order of
 *   magnitude (45-60s) — the cost is inherent to the algorithm, not a
 *   regression, so the optimization isn't worth the added complexity today.
 *   See `tryInflateAt`'s sibling, `usedAtMostNBytes`, for how a *narrower*
 *   piece of the same consumed-byte information is still recovered where it
 *   affects correctness, not just speed.
 * - **The raw-deflate `c > 16` guard is recovered indirectly, not tracked.**
 *   Python discards a raw-deflate match that consumed 16 or fewer compressed
 *   bytes (`research/d9-decode.py`'s `inflate_all`) — a common false positive
 *   on padding-like runs. `InflateUtil` doesn't report consumed bytes at all,
 *   so `usedAtMostNBytes` checks the same thing by re-attempting the decode
 *   against a truncated 16-byte input and comparing output: a genuine stream
 *   self-terminates and needs no more input once it does, so an identical
 *   result from the truncated input proves it needed 16 bytes or fewer.
 * - **Dedup by direct byte comparison, not `hash()`.** REVIEW-BACKLOG.md logs
 *   the Python original's dedup as able to silently drop a real stream on a
 *   hash collision. The candidate count here is always small (a handful of
 *   `TessData`-bearing blocks survive filtering, not the hundreds of
 *   thousands of scan offsets), so pairwise equality is cheap enough to just
 *   be correct by construction.
 */
export function extractTessDataStreams(
  fileBytes: Uint8Array,
): readonly Uint8Array[] {
  const budget = new DecompressionBudget(MAX_TOTAL_INFLATED_BYTES);
  const allStreams: Uint8Array[] = [];
  collect(fileBytes, 0, allStreams, budget);

  const withMagic = allStreams.filter((stream) =>
    containsAscii(stream, TESS_DATA_MAGIC),
  );
  return dedupeByBytes(withMagic);
}

/**
 * A shrinking cap shared across one whole recursive scan. Mutable by design:
 * the alternative is threading a running total back out through both
 * `collect`'s recursion and `inflateAll`'s loop, for a value that only ever
 * decreases and is never read concurrently.
 */
class DecompressionBudget {
  private remainingBytes: number;

  constructor(totalBytes: number) {
    this.remainingBytes = totalBytes;
  }

  /**
   * Records a spend. Returns `false` once the aggregate cap is exceeded —
   * matching `research/d9-decode.py`'s `budget[0] < 0`, including that the
   * spend which tipped it over is itself rejected, not counted as found.
   */
  spend(bytes: number): boolean {
    this.remainingBytes -= bytes;
    return this.remainingBytes >= 0;
  }
}

function collect(
  buf: Uint8Array,
  depth: number,
  acc: Uint8Array[],
  budget: DecompressionBudget,
): void {
  if (depth > MAX_RECURSION_DEPTH) {
    return;
  }
  const children = inflateAll(buf, budget);
  if (children.length === 0) {
    // Aliases the caller's own buffer at depth 0 (nothing here copies it) —
    // accepted rather than defensively copied, since it only surfaces if the
    // *original file bytes* both contain no inflatable stream at all and
    // literally contain the ASCII "TessData" magic, which no real SLDPRT
    // file does (FINDINGS.md section 5: the whole format is deflate blocks).
    acc.push(buf);
    return;
  }
  for (const child of children) {
    acc.push(child);
    collect(child, depth + 1, acc, budget);
  }
}

// research/d9-decode.py rejects a raw-deflate match (only raw — zlib's
// header checksum already rules out this kind of false positive) that
// consumed 16 or fewer compressed bytes to produce its output
// (`c = n - i - len(o.unused_data); if c > 16`). Without that guard, a short
// run of padding-like bytes can decode into a large, spurious "stream" —
// confirmed by code review of this commit, which is why it's here at all.
const RAW_DEFLATE_MIN_CONSUMED_BYTES = 16;

/**
 * Scans every offset of `buf` for a zlib-wrapped or raw-deflate stream
 * (`InflateUtil` tries zlib first — cheap to rule out — then raw). Once the
 * shared budget is exceeded, stops and returns whatever was already found:
 * every later call sharing this budget will immediately see the same thing,
 * so the whole recursive scan winds down from here rather than crashing.
 */
function inflateAll(
  buf: Uint8Array,
  budget: DecompressionBudget,
): Uint8Array[] {
  const found: Uint8Array[] = [];
  let offset = 0;
  while (offset < buf.length - MIN_SCANNABLE_TAIL_BYTES) {
    const output = tryInflateAt(buf, offset);
    if (output === undefined || output.length < MIN_ACCEPTED_OUTPUT_BYTES) {
      offset += 1;
      continue;
    }
    if (!budget.spend(output.length)) {
      return found;
    }
    found.push(output);
    offset += 1;
  }
  return found;
}

function tryInflateAt(buf: Uint8Array, offset: number): Uint8Array | undefined {
  const zlibOutput = tryInflateZlib(buf, offset, MAX_OUTPUT_BYTES_PER_ATTEMPT);
  if (zlibOutput !== undefined) {
    return zlibOutput;
  }
  const rawOutput = tryInflateRaw(buf, offset, MAX_OUTPUT_BYTES_PER_ATTEMPT);
  if (rawOutput === undefined || usedAtMostNBytes(buf, offset, rawOutput)) {
    return undefined;
  }
  return rawOutput;
}

/**
 * `InflateUtil` doesn't report how many compressed bytes an attempt
 * consumed, so this checks the same thing `research/d9-decode.py` does
 * indirectly: a genuine deflate stream self-terminates and needs no more
 * input once it does, so if truncating the input to
 * `RAW_DEFLATE_MIN_CONSUMED_BYTES` still decodes to this exact output, the
 * real stream consumed that many compressed bytes or fewer.
 */
function usedAtMostNBytes(
  buf: Uint8Array,
  offset: number,
  output: Uint8Array,
): boolean {
  const truncated = tryInflateRaw(
    buf.subarray(0, offset + RAW_DEFLATE_MIN_CONSUMED_BYTES),
    offset,
    output.length,
  );
  return truncated !== undefined && bytesEqual(truncated, output);
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
