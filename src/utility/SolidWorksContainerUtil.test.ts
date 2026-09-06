import { readFileSync } from "node:fs";
import { deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import { extractModernContainerChunks } from "./SolidWorksContainerUtil";

const SOLIDWORKS_DIR = "assets/solidworks";
const CHUNK_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const CHUNK_HEADER_SIZE = 0x1e;
const INLINE_F1 = 100_000;
const REFERENCE_F1 = 1;

function readSldprt(name: string): Uint8Array {
  return readFileSync(`${SOLIDWORKS_DIR}/${name}`);
}

/** The exact inverse of production's rotate-left name cipher. */
function rotateRightByte(byte: number, bits: number): number {
  const shift = bits & 7;
  if (shift === 0) {
    return byte;
  }
  return ((byte >>> shift) | (byte << (8 - shift))) & 0xff;
}

interface ChunkSpec {
  readonly name: string;
  readonly payload: Uint8Array;
  /** Defaults to a real inline chunk; pass a value below the 65,536
   * inline-data threshold to build a reference (data-less) chunk instead. */
  readonly f1?: number;
}

/**
 * Builds one chunk record, `SolidWorksContainerUtil.ts`'s own doc comment
 * layout, independently re-derived rather than importing any constant from
 * production — so this actually cross-checks the parser against the format,
 * not against its own implementation.
 */
function buildChunk(spec: ChunkSpec, key: number): Uint8Array {
  const compressed = deflateRaw(spec.payload);
  const nameBytes = new TextEncoder().encode(spec.name);
  const encodedName = Uint8Array.from(nameBytes, (b) =>
    rotateRightByte(b, key),
  );
  const f1 = spec.f1 ?? INLINE_F1;
  const isInline = f1 >= 65_536;
  const dataLength = isInline ? compressed.length : 0;
  const bytes = new Uint8Array(
    CHUNK_HEADER_SIZE + encodedName.length + dataLength,
  );
  const view = new DataView(bytes.buffer);
  bytes.set(CHUNK_MARKER, 4);
  view.setUint32(0x0e, f1, true);
  view.setUint32(0x12, dataLength, true);
  view.setUint32(0x16, isInline ? spec.payload.length : 0, true);
  view.setUint32(0x1a, encodedName.length, true);
  bytes.set(encodedName, CHUNK_HEADER_SIZE);
  if (isInline) {
    bytes.set(compressed, CHUNK_HEADER_SIZE + encodedName.length);
  }
  return bytes;
}

/** A synthetic "file": an 8-byte header (byte 7 is the ROL key, matching
 * production's own `ROL_KEY_BYTE_OFFSET`) followed by concatenated chunks. */
function buildFile(key: number, chunks: readonly ChunkSpec[]): Uint8Array {
  const chunkBytes = chunks.map((chunk) => buildChunk(chunk, key));
  const header = new Uint8Array(8);
  header[7] = key;
  const totalLength =
    header.length + chunkBytes.reduce((sum, c) => sum + c.length, 0);
  const bytes = new Uint8Array(totalLength);
  bytes.set(header, 0);
  let offset = header.length;
  for (const chunk of chunkBytes) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const KEY = 0x04; // matches every real sample file seen so far, not required

describe("extractModernContainerChunks", () => {
  it("finds nothing in an empty buffer", () => {
    expect(extractModernContainerChunks(new Uint8Array(0))).toEqual([]);
  });

  it("finds nothing in bytes with no marker at all", () => {
    const bytes = new TextEncoder().encode(
      "not a SolidWorks file, no chunk marker anywhere in here",
    );

    expect(extractModernContainerChunks(bytes)).toEqual([]);
  });

  it("recovers one chunk's name and decompressed payload", () => {
    const payload = new TextEncoder().encode("hello tessellation cache");
    const file = buildFile(KEY, [{ name: "Contents/DisplayLists", payload }]);

    const chunks = extractModernContainerChunks(file);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.name).toBe("Contents/DisplayLists");
    expect(chunks[0]?.data).toEqual(payload);
  });

  it("recovers multiple chunks in file order", () => {
    const first = new TextEncoder().encode("first payload");
    const second = new TextEncoder().encode("second payload, a bit longer");
    const file = buildFile(KEY, [
      { name: "docProps/custom.xml", payload: first },
      { name: "Contents/DisplayLists", payload: second },
    ]);

    const chunks = extractModernContainerChunks(file);

    expect(chunks.map((c) => c.name)).toEqual([
      "docProps/custom.xml",
      "Contents/DisplayLists",
    ]);
    expect(chunks[1]?.data).toEqual(second);
  });

  it("skips a reference chunk that carries no inline data", () => {
    const payload = new TextEncoder().encode("real payload");
    const file = buildFile(KEY, [
      { name: "SomeReference", payload: new Uint8Array(0), f1: REFERENCE_F1 },
      { name: "Contents/DisplayLists", payload },
    ]);

    const chunks = extractModernContainerChunks(file);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.name).toBe("Contents/DisplayLists");
  });

  it("decodes names correctly for a key other than the one every sample so far happens to use", () => {
    const payload = new TextEncoder().encode("payload");
    const file = buildFile(0x5a, [{ name: "Contents/VBLists", payload }]);

    const chunks = extractModernContainerChunks(file);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.name).toBe("Contents/VBLists");
  });

  it("does not mistake a coincidental marker in unrelated bytes for a real chunk", () => {
    // The 6-byte marker embedded in otherwise-random bytes, with no valid
    // header around it — every real chunk's declared sizes/name must still
    // check out, so this must be silently skipped, not throw or fabricate
    // a chunk.
    const bytes = new Uint8Array(200).fill(0x33);
    bytes.set(CHUNK_MARKER, 50);

    expect(extractModernContainerChunks(bytes)).toEqual([]);
  });

  it("finds the same TessData-bearing stream in a real NIST part that extractTessDataStreams's brute-force scan already verifies byte-for-byte", () => {
    const chunks = extractModernContainerChunks(
      readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
    );

    const tessDataChunks = chunks.filter((chunk) =>
      new TextDecoder().decode(chunk.data).includes("TessData"),
    );
    expect(tessDataChunks).toHaveLength(1);
    expect(tessDataChunks[0]?.name).toBe("Contents/DisplayLists");
    expect(tessDataChunks[0]?.data).toHaveLength(287_403);
  });
  // No extended timeout needed — this is the entire point of D14: this
  // real file parses in single-digit milliseconds now, not 45-60 seconds.
});
