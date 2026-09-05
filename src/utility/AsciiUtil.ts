/**
 * Case-insensitive ASCII prefix match — no domain knowledge, just bytes.
 * Only correct for an all-letters `text`, already lowercase: the trick
 * (`byte | 0x20`) only folds case for letters, not digits or punctuation.
 *
 * Pulled out of FormatSniffEngine so MeshDecodeEngine can reuse it for its
 * own ASCII-STL check without an Engine importing another Engine, which
 * ARCHITECTURE.md section 2 forbids.
 */
export function startsWithAsciiCaseInsensitive(
  bytes: Uint8Array,
  text: string,
): boolean {
  if (bytes.byteLength < text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const byte = bytes[i];
    if (byte === undefined || (byte | 0x20) !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}
