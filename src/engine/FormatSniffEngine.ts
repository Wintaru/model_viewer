import type { FormatId } from "../common/FormatId";
import { startsWithAsciiCaseInsensitive } from "../utility/AsciiUtil";
import {
  readFixedRecordCount,
  type FixedRecordLayout,
} from "../utility/BinaryLayoutUtil";

const STEP_SIGNATURE = "ISO-10303-21;";
const DXF_SECTION_KEYWORD = "SECTION";
const ASCII_ZERO = 0x30;

const SOLIDWORKS_SIGNATURE_OFFSET = 4;
const SOLIDWORKS_SIGNATURE = [0x00, 0x00, 0x00, 0x04];

const STL_LAYOUT: FixedRecordLayout = { headerSize: 80, recordSize: 50 };

/**
 * Bytes to a format identifier. Pure. Implements the sniff step of
 * ARCHITECTURE.md section 4's format-dispatch diagram — see that section
 * for the SolidWorks byte-4-to-7 signature and why it, not bytes 0 to 3, is
 * the one that holds across the whole NIST corpus.
 *
 * Known, deliberate gaps, not oversights:
 * - **IGES is not detected.** The diagram lumps it in with STEP under one
 *   arrow, but real IGES files don't carry STEP's `ISO-10303-21;` header —
 *   they use fixed-width 80-column card records with a section letter at
 *   column 73, a different and more involved check. No IGES file exists
 *   anywhere in this repository to verify a heuristic against, so this
 *   ships undetected rather than guessed. See REVIEW-BACKLOG.md.
 * - **Binary STL is only detected when `transform` receives the whole
 *   file.** Its only signature is a triangle count at offset 80 that must
 *   make the total length add up — there is no magic prefix. Given only a
 *   short "sniff first" prefix (ARCHITECTURE.md section 3, `readRange(0,
 *   4096)`), a binary STL larger than the prefix cannot be identified this
 *   way and `transform` returns `undefined`. ASCII STL (`solid` prefix) is
 *   unaffected, since its signature IS in the first few bytes.
 * - **OBJ, PLY, glTF and 3MF are not detected**, matching
 *   REVIEW-BACKLOG.md's "MeshDecodeEngine scope" note that only STL has a
 *   decoder, or a plan, in slice 1.
 */
export class FormatSniffEngine {
  transform(bytes: Uint8Array): FormatId | undefined {
    if (looksLikeStep(bytes)) {
      return "step";
    }
    if (looksLikeSolidWorks(bytes)) {
      return "solidworks";
    }
    if (looksLikeDxf(bytes)) {
      return "dxf";
    }
    if (looksLikeAsciiStl(bytes) || looksLikeBinaryStl(bytes)) {
      return "stl";
    }
    return undefined;
  }
}

function looksLikeStep(bytes: Uint8Array): boolean {
  return startsWithAscii(
    bytes,
    STEP_SIGNATURE,
    skipLeadingAsciiWhitespace(bytes),
  );
}

function looksLikeSolidWorks(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength <
    SOLIDWORKS_SIGNATURE_OFFSET + SOLIDWORKS_SIGNATURE.length
  ) {
    return false;
  }
  return SOLIDWORKS_SIGNATURE.every(
    (expected, i) => bytes[SOLIDWORKS_SIGNATURE_OFFSET + i] === expected,
  );
}

function looksLikeDxf(bytes: Uint8Array): boolean {
  const zeroAt = skipLeadingAsciiWhitespace(bytes);
  if (bytes[zeroAt] !== ASCII_ZERO) {
    return false;
  }
  const afterZero = zeroAt + 1;
  const afterZeroByte = bytes[afterZero];
  if (afterZeroByte === undefined || !isAsciiWhitespace(afterZeroByte)) {
    return false;
  }
  return startsWithAscii(
    bytes,
    DXF_SECTION_KEYWORD,
    skipLeadingAsciiWhitespace(bytes, afterZero),
  );
}

function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  return startsWithAsciiCaseInsensitive(
    bytes.subarray(skipLeadingAsciiWhitespace(bytes)),
    "solid",
  );
}

function looksLikeBinaryStl(bytes: Uint8Array): boolean {
  return readFixedRecordCount(bytes, STL_LAYOUT) !== undefined;
}

function startsWithAscii(
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

function skipLeadingAsciiWhitespace(bytes: Uint8Array, start = 0): number {
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

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
