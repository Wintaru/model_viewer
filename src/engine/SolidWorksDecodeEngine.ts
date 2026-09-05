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
