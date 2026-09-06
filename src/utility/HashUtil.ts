const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

/**
 * A content hash for cache-key derivation — ARCHITECTURE.md section 6a's
 * `cacheKey = hash(file bytes) + decoderName + decoderVersion + optionsHash`.
 * SHA-256 over the Web Crypto API (`crypto.subtle.digest`), a global
 * available in every browser and in Node, so no hashing dependency is
 * needed. Returned as lowercase hex, the conventional text form for a
 * digest used as a cache key or filename.
 *
 * Takes no dependency on `Common` or any other layer, so this stays a
 * Utility leaf.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return toHex(new Uint8Array(digest));
}

// TypeScript's typed arrays are generic over their backing buffer as of
// TS 5.7+. An unparameterized `Uint8Array` parameter widens to the loose
// `Uint8Array<ArrayBufferLike>` default, which `crypto.subtle.digest`'s
// `BufferSource` parameter then rejects — the same gotcha
// `ModelLoadManager.test.ts`'s `binaryStl` helper and `node-fs.d.ts` already
// document. Copying into a freshly allocated `Uint8Array` (always backed by
// a real `ArrayBuffer`, never a `SharedArrayBuffer`) sidesteps it.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}
