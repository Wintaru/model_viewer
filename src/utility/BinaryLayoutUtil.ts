const RECORD_COUNT_FIELD_SIZE = 4;

/** A binary layout of a fixed header, a record count, then N fixed-size records. */
export interface FixedRecordLayout {
  /** Bytes before the record count — e.g. binary STL's 80-byte header. */
  readonly headerSize: number;
  /** Bytes each record occupies — e.g. 50 for one binary STL triangle. */
  readonly recordSize: number;
}

/**
 * Reads a little-endian uint32 record count right after `headerSize` bytes,
 * then checks that `headerSize + 4 + count * recordSize` equals the total
 * byte length. Returns the count only if it does.
 *
 * No knowledge of what format it validates — just "does a header, then a
 * count, then N fixed-size records, add up." Pulled out of MeshDecodeEngine
 * and FormatSniffEngine so the algorithm isn't duplicated between two
 * Engines that can't import each other; the format-specific sizes still
 * live in each caller.
 */
export function readFixedRecordCount(
  bytes: Uint8Array,
  layout: FixedRecordLayout,
): number | undefined {
  if (bytes.byteLength < layout.headerSize + RECORD_COUNT_FIELD_SIZE) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(layout.headerSize, true);
  const expectedLength =
    layout.headerSize + RECORD_COUNT_FIELD_SIZE + count * layout.recordSize;
  return expectedLength === bytes.byteLength ? count : undefined;
}
