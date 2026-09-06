import { Inflate, Z_OK } from "pako";

/**
 * Reads a modern (2015-onward) SolidWorks file's real container structure —
 * WAYFINDER.md's D12/D13/D14: the format `SolidWorksDecodeEngine.ts` used to
 * find only by brute force (trying a decompression at every byte offset) is
 * not OLE2/CFBF and has no published spec, but it does have a documented,
 * working open-source reader: `openswx`'s `ParseModernFormat`
 * (`libopenswx/src/internal/modern_parser.cc`, MIT,
 * github.com/schwitters/openswx). This is a from-scratch TypeScript port of
 * that function's chunk layout and scan algorithm — read directly from its
 * source via `gh api`, not taken secondhand from its README — validated
 * against all 11 NIST SLDPRT fixtures this repo already ships plus several
 * real customer SLDPRT/SLDDRW files (DECISIONS.md's D14 entry, gitignored):
 * every one parses in 2-95 milliseconds and lands its tessellation cache in
 * exactly one chunk, versus 45-60 seconds (SLDPRT) to several minutes or an
 * outright hang (SLDDRW) for the byte-by-byte scan it replaces.
 *
 * Record layout, one chunk (chunk starts 4 bytes before the marker):
 *
 *   byte 0x00   4 bytes   file-specific, not used here
 *   byte 0x04   6 bytes   the marker: 14 00 06 00 08 00
 *   byte 0x0a   1 byte    section type (unused here — content, not this
 *                         byte, is how this project already tells a
 *                         tessellation-bearing chunk apart from any other)
 *   byte 0x0b   3 bytes   file-specific, not used here
 *   byte 0x0e   u32 LE    f1 — >= 65536 means this chunk carries inline data
 *   byte 0x12   u32 LE    compressed size
 *   byte 0x16   u32 LE    uncompressed size
 *   byte 0x1a   u32 LE    stream name length, in bytes
 *   byte 0x1e   variable  the name, ciphered — see {@link rolDecodeByte}
 *   ...         variable  raw-deflate compressed data (inline chunks only)
 *
 * A chunk with no inline data (`f1 < 65536`) is a reference with nothing to
 * extract here, so it's skipped rather than returned.
 */

const CHUNK_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const MARKER_OFFSET_IN_CHUNK = 4;
const CHUNK_HEADER_SIZE = 0x1e;
const F1_OFFSET = 0x0e;
const COMPRESSED_SIZE_OFFSET = 0x12;
const UNCOMPRESSED_SIZE_OFFSET = 0x16;
const NAME_LENGTH_OFFSET = 0x1a;
const INLINE_DATA_THRESHOLD = 65_536;
const ROL_KEY_BYTE_OFFSET = 7;
const MAX_NAME_BYTES = 512;
// Generous, not tight — this only bounds one already-located real chunk's
// declared uncompressed size against corruption/coincidence, not a blind
// per-offset attempt the way SolidWorksDecodeEngine.ts's old scan needed to.
// A real SLDDRW sample's tessellation chunk alone decompresses to 46.6 MiB
// (DECISIONS.md's D14 entry), so this stays well above that with headroom.
const MAX_UNCOMPRESSED_BYTES = 512 << 20;
// A per-chunk cap alone doesn't bound total memory across one call: a
// crafted file could embed many small, cheaply-compressed chunks that each
// individually stay under MAX_UNCOMPRESSED_BYTES but still add up. Mirrors
// the old `collect`/`inflateAll` machinery's own `MAX_TOTAL_INFLATED_BYTES`
// aggregate guard, which this file's algorithm otherwise has no equivalent
// of — a real file's total decompressed content across every chunk (TessData
// included) has stayed under 50 MiB in everything measured so far, so this
// leaves generous headroom while still bounding a pathological file.
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 << 20;
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX_EXCLUSIVE = 0x80;

export interface ModernContainerChunk {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * Finds every inline-data chunk in a modern SolidWorks container and
 * decompresses each one. Returns an empty array for bytes that don't
 * contain the marker at all (an older, OLE2-era file, or not a SolidWorks
 * file), never throws.
 */
export function extractModernContainerChunks(
  fileBytes: Uint8Array,
): readonly ModernContainerChunk[] {
  const key = fileBytes[ROL_KEY_BYTE_OFFSET];
  if (key === undefined) {
    return [];
  }
  const chunks: ModernContainerChunk[] = [];
  let searchPos = 0;
  let totalUncompressedBytes = 0;

  while (true) {
    const markerPos = indexOfMarker(fileBytes, searchPos);
    if (markerPos === -1) {
      break;
    }
    if (markerPos < MARKER_OFFSET_IN_CHUNK) {
      searchPos = markerPos + 1;
      continue;
    }

    const chunkStart = markerPos - MARKER_OFFSET_IN_CHUNK;
    if (chunkStart + CHUNK_HEADER_SIZE > fileBytes.length) {
      searchPos = markerPos + 1;
      continue;
    }

    const f1 = readU32(fileBytes, chunkStart + F1_OFFSET);
    const compressedSize = readU32(
      fileBytes,
      chunkStart + COMPRESSED_SIZE_OFFSET,
    );
    const uncompressedSize = readU32(
      fileBytes,
      chunkStart + UNCOMPRESSED_SIZE_OFFSET,
    );
    const nameLength = readU32(fileBytes, chunkStart + NAME_LENGTH_OFFSET);
    if (
      nameLength > MAX_NAME_BYTES ||
      uncompressedSize > MAX_UNCOMPRESSED_BYTES
    ) {
      searchPos = markerPos + 1;
      continue;
    }

    const nameStart = chunkStart + CHUNK_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > fileBytes.length) {
      searchPos = markerPos + 1;
      continue;
    }

    const name = rolDecodeName(fileBytes, nameStart, nameLength, key);
    if (name === undefined) {
      searchPos = markerPos + 1;
      continue;
    }

    const isInline = f1 >= INLINE_DATA_THRESHOLD;
    if (!isInline || compressedSize === 0) {
      searchPos = markerPos + CHUNK_MARKER.length;
      continue;
    }

    const dataStart = nameEnd;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > fileBytes.length) {
      searchPos = markerPos + 1;
      continue;
    }

    if (
      totalUncompressedBytes + uncompressedSize >
      MAX_TOTAL_UNCOMPRESSED_BYTES
    ) {
      // Budget exhausted — stop rather than keep spending on whatever real
      // or forged chunks remain, matching the old scan's own aggregate-cap
      // behavior (return what's already found rather than throw).
      break;
    }

    // The declared uncompressed size caps this decompression precisely,
    // rather than a generic guess — and doubles as a validity check: a
    // coincidental marker match in unrelated bytes essentially never
    // decompresses to exactly its own declared length.
    const data = inflateRawUpTo(
      fileBytes.subarray(dataStart, dataEnd),
      uncompressedSize,
    );
    if (data === undefined || data.length !== uncompressedSize) {
      // A real chunk's own bytes are corrupt (rare), or this was a
      // coincidental marker match that passed every earlier guard but still
      // isn't a real chunk (rarer still, given the marker plus a valid
      // printable-ASCII name plus matching declared/actual length already
      // ruled almost everything else out). Either way, retreat by one byte
      // rather than jumping to `dataEnd` — `compressedSize` came from the
      // same unverified header, so trusting it to skip forward here could
      // skip past a real chunk that follows.
      searchPos = markerPos + 1;
      continue;
    }
    totalUncompressedBytes += data.length;
    chunks.push({ name, data });
    searchPos = dataEnd;
  }

  return chunks;
}

function indexOfMarker(bytes: Uint8Array, fromIndex: number): number {
  const limit = bytes.length - CHUNK_MARKER.length;
  for (let i = Math.max(fromIndex, 0); i <= limit; i++) {
    if (matchesMarkerAt(bytes, i)) {
      return i;
    }
  }
  return -1;
}

function matchesMarkerAt(bytes: Uint8Array, offset: number): boolean {
  return CHUNK_MARKER.every((expected, i) => bytes[offset + i] === expected);
}

function readU32(bytes: Uint8Array, offset: number): number {
  // Little-endian, matching the rest of this codebase's own u32 readers
  // (SolidWorksDecodeEngine.ts's readU32) — plain arithmetic rather than a
  // DataView here since every read in this file is 4-byte-aligned relative
  // to its own chunk start, with no cross-alignment scanning needed (unlike
  // that file's own tessellation-block reader).
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    b0 === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined
  ) {
    return 0;
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

/**
 * Decodes a chunk's ROL-ciphered (rotate-left) name, or returns `undefined`
 * if the result isn't a plausible stream name — the same false-positive
 * guard `openswx`'s `IsValidStreamName` uses, load-bearing here too: without
 * it, a coincidental 6-byte marker match in unrelated binary data would
 * still "succeed" with a garbage name instead of being rejected.
 */
function rolDecodeName(
  bytes: Uint8Array,
  start: number,
  length: number,
  key: number,
): string | undefined {
  if (length === 0) {
    return undefined;
  }
  const decoded = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const byte = bytes[start + i];
    if (byte === undefined) {
      return undefined;
    }
    const rolled = rolDecodeByte(byte, key);
    if (
      rolled < PRINTABLE_ASCII_MIN ||
      rolled >= PRINTABLE_ASCII_MAX_EXCLUSIVE
    ) {
      return undefined;
    }
    decoded[i] = rolled;
  }
  // Every byte here already passed the printable-ASCII check above, so a
  // plain UTF-8 decode (this codebase's existing convention — see
  // DxfDecodeEngine.ts) reproduces it exactly: ASCII is UTF-8's own 7-bit
  // subset, byte for byte.
  return new TextDecoder().decode(decoded);
}

/**
 * Rotates one byte left by `key` bits (masked to 0-7) — SolidWorks's own
 * per-file cipher for chunk names, keyed by byte 7 of the file. Self-inverse
 * for a full-byte rotation, so encode and decode are the same operation;
 * `openswx`'s `rol_codec.h` notes this explicitly.
 */
function rolDecodeByte(byte: number, key: number): number {
  const shift = key & 7;
  if (shift === 0) {
    return byte;
  }
  return ((byte << shift) | (byte >>> (8 - shift))) & 0xff;
}

/**
 * Signals that {@link Inflate.onData} saw more output than `maxOutputBytes`
 * allows — aborts decompression mid-stream, matching `InflateUtil.ts`'s own
 * `OutputTooLargeError`. Not imported from there: `.dependency-cruiser.js`'s
 * `no-utility-outbound` rule forbids a Utility calling another Utility (or
 * anything else) — Utility is a cross-cutting leaf every layer may call, so
 * it may not call sideways either. This small streaming-with-a-cap helper
 * is duplicated rather than shared for that reason, not an oversight.
 */
class OutputTooLargeError extends Error {}

/**
 * Raw-deflate-decompresses `compressed` in full, aborting (returning
 * `undefined`) if the output would exceed `maxOutputBytes` — a zip-bomb
 * guard even though the caller already knows the declared uncompressed
 * size, since that declaration is itself unverified until decompression
 * actually confirms it.
 */
function inflateRawUpTo(
  compressed: Uint8Array,
  maxOutputBytes: number,
): Uint8Array | undefined {
  const inflate = new Inflate({ raw: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  inflate.onData = (chunk: Uint8Array) => {
    totalBytes += chunk.length;
    if (totalBytes > maxOutputBytes) {
      throw new OutputTooLargeError();
    }
    chunks.push(chunk);
  };

  try {
    inflate.push(compressed, true);
  } catch (error) {
    if (error instanceof OutputTooLargeError) {
      return undefined;
    }
    throw error;
  }

  if (inflate.err !== Z_OK || totalBytes === 0) {
    return undefined;
  }
  return concatChunks(chunks, totalBytes);
}

function concatChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first !== undefined) {
    return first;
  }
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
