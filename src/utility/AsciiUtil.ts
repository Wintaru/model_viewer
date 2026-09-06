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

/**
 * Exact (case-sensitive) ASCII prefix match at a given byte offset. Pulled
 * out of `FormatSniffEngine` so `OcctDecodeEngine` can reuse it for its own
 * STEP-vs-IGES check without an Engine importing another Engine — the same
 * reason `startsWithAsciiCaseInsensitive` above lives here.
 */
export function startsWithAscii(
  bytes: Uint8Array,
  text: string,
  offset: number,
): boolean {
  if (bytes.byteLength < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

export function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Index of the first non-whitespace byte at or after `start`. */
export function skipLeadingAsciiWhitespace(
  bytes: Uint8Array,
  start = 0,
): number {
  let i = start;
  while (i < bytes.byteLength) {
    const byte = bytes[i];
    if (byte === undefined || !isAsciiWhitespace(byte)) {
      break;
    }
    i++;
  }
  return i;
}

const STEP_SIGNATURE = "ISO-10303-21;";

/**
 * Does this look like a STEP file? The one function below with real domain
 * knowledge in an otherwise domain-free file — it lives here, rather than
 * its own small module, because Utility "calls nothing else"
 * (ARCHITECTURE.md section 2: every layer may call Utility, but Utility may
 * not call another Utility), so a separate module could not import the two
 * primitives above without breaking that rule.
 *
 * Shared by `FormatSniffEngine` (routes `'step'` vs `'iges'` bytes to
 * `ModelLoadManager`) and `OcctDecodeEngine` (picks `ReadStepFile` vs
 * `ReadIgesFile` for bytes already routed here as one of those two). Those
 * two checks must never disagree — a mismatch would route a real STEP file
 * to `ReadIgesFile`, misreporting a routing bug as "IGES holding only
 * wireframe entities." One shared function, rather than the identical
 * constant and logic duplicated in both engines (an Engine may not import
 * another Engine, so this is the one place both can reach), makes that
 * mismatch impossible instead of merely unlikely.
 */
export function looksLikeStepFile(bytes: Uint8Array): boolean {
  return startsWithAscii(
    bytes,
    STEP_SIGNATURE,
    skipLeadingAsciiWhitespace(bytes),
  );
}
