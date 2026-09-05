import { Inflate, Z_OK } from "pako";

const ZLIB_HEADER_BYTE = 0x78;
const ZLIB_HEADER_CHECK_MODULUS = 31;

/**
 * Signals that {@link Inflate.onData} saw more output than the caller's cap
 * allows. Thrown from inside `push()`'s own loop (pako's source has no
 * surrounding try/catch there — confirmed by reading `dist/pako.cjs.js`
 * directly), so it aborts decompression mid-stream rather than after
 * inflating the whole thing. Never leaves {@link tryInflate}.
 */
class OutputTooLargeError extends Error {}

/**
 * Attempts a zlib-wrapped (RFC 1950) inflate of `bytes` starting at `offset`,
 * stopping wherever the compressed stream ends — trailing bytes are ignored,
 * the same as `research/d9-decode.py`'s `zlib.decompressobj()`. Returns
 * `undefined`, never throws, for anything that isn't a complete, valid
 * stream, or whose decompressed output would exceed `maxOutputBytes`.
 *
 * Checks the two-byte zlib header before attempting decompression at all —
 * the same cheap guard `research/d9-decode.py`'s `inflate_all` uses to skip
 * the expensive attempt at nearly every offset it visits.
 *
 * `offset` must be within `[0, bytes.length]` — the header check happens to
 * reject a negative one, but that's incidental, not a guarantee.
 */
export function tryInflateZlib(
  bytes: Uint8Array,
  offset: number,
  maxOutputBytes: number,
): Uint8Array | undefined {
  if (!looksLikeZlibHeader(bytes, offset)) {
    return undefined;
  }
  return tryInflate(bytes, offset, { raw: false, maxOutputBytes });
}

/**
 * Attempts a raw-deflate (RFC 1951, no header) inflate of `bytes` starting at
 * `offset`. Unlike {@link tryInflateZlib}, raw deflate carries no signature
 * to pre-check — `research/scan-deflate.py`'s own docstring calls this
 * "attempt an inflate at every byte offset" — so every call here actually
 * runs the decompressor.
 *
 * `offset` must be within `[0, bytes.length]`. A negative offset is not
 * rejected — `Uint8Array.prototype.subarray` counts it from the end of the
 * buffer instead of treating it as out of range — so a caller passing one
 * would silently scan the wrong bytes rather than get `undefined` back.
 */
export function tryInflateRaw(
  bytes: Uint8Array,
  offset: number,
  maxOutputBytes: number,
): Uint8Array | undefined {
  return tryInflate(bytes, offset, { raw: true, maxOutputBytes });
}

function looksLikeZlibHeader(bytes: Uint8Array, offset: number): boolean {
  const cmf = bytes[offset];
  const flg = bytes[offset + 1];
  if (cmf === undefined || flg === undefined) {
    return false;
  }
  return (
    cmf === ZLIB_HEADER_BYTE &&
    ((cmf << 8) | flg) % ZLIB_HEADER_CHECK_MODULUS === 0
  );
}

function tryInflate(
  bytes: Uint8Array,
  offset: number,
  options: { readonly raw: boolean; readonly maxOutputBytes: number },
): Uint8Array | undefined {
  const inflate = new Inflate({ raw: options.raw });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  inflate.onData = (chunk: Uint8Array) => {
    totalBytes += chunk.length;
    if (totalBytes > options.maxOutputBytes) {
      throw new OutputTooLargeError();
    }
    chunks.push(chunk);
  };

  try {
    inflate.push(bytes.subarray(offset), true);
  } catch (error) {
    if (error instanceof OutputTooLargeError) {
      return undefined;
    }
    throw error;
  }

  if (inflate.err !== Z_OK || totalBytes === 0) {
    return undefined;
  }
  return concat(chunks, totalBytes);
}

function concat(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
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
