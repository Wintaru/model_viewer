import type { FormatId } from "../common/FormatId.js";
import {
  isAsciiWhitespace,
  looksLikeStepFile,
  skipLeadingAsciiWhitespace,
  startsWithAscii,
  startsWithAsciiCaseInsensitive,
} from "../utility/AsciiUtil.js";
import {
  readFixedRecordCount,
  type FixedRecordLayout,
} from "../utility/BinaryLayoutUtil.js";

const DXF_SECTION_KEYWORD = "SECTION";
const ASCII_ZERO = 0x30;

// IGES's fixed-width ASCII layout: every record is exactly 80 columns, the
// section letter sits at column 73 (index 72), and a well-formed file's
// very first record is always its Start section, letter 'S'. Confirmed
// against three real IGES 5.3 files (research/FINDINGS.md) — every one
// begins "...<69 chars>      S      1", the section letter followed by a
// right-justified sequence number filling out the record to 80 columns.
const IGES_RECORD_WIDTH = 80;
const IGES_SECTION_LETTER_COLUMN = 72;
const IGES_START_SECTION_LETTER = 0x53; // 'S'

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
    if (looksLikeStepFile(bytes)) {
      return "step";
    }
    if (looksLikeIges(bytes)) {
      return "iges";
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

function looksLikeIges(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= IGES_RECORD_WIDTH) {
    return false;
  }
  if (bytes[IGES_SECTION_LETTER_COLUMN] !== IGES_START_SECTION_LETTER) {
    return false;
  }
  const terminator = bytes[IGES_RECORD_WIDTH];
  return terminator !== undefined && isAsciiLineEnd(terminator);
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

function isAsciiLineEnd(byte: number): boolean {
  return byte === 0x0a || byte === 0x0d;
}
