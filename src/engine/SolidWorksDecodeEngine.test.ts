import { readFileSync } from "node:fs";
import { deflate, deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import { extractTessDataStreams } from "./SolidWorksDecodeEngine";

const SOLIDWORKS_DIR = "assets/solidworks";
const TESS_DATA_MAGIC = "TessData";

function readSldprt(name: string): Uint8Array {
  return readFileSync(`${SOLIDWORKS_DIR}/${name}`);
}

/**
 * Non-compressible-looking bytes, long enough to clear the 256-byte minimum
 * `extractTessDataStreams` requires, with the magic marker embedded midway
 * through — same shape as a real TessData stream (a header, then a large
 * block of tessellation data), without needing a real file.
 */
function tessDataPayload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (i * 7 + 3) % 256;
  }
  bytes.set(new TextEncoder().encode(TESS_DATA_MAGIC), Math.floor(length / 2));
  return bytes;
}

// Measured by hand (DECISIONS.md): the full recursive scan takes tens of
// seconds even in research/d9-decode.py's own C-accelerated zlib (36s for
// this exact file), because trying every offset at up to 5 nested levels is
// inherently expensive — not something this port regressed. Generous, not
// tight: real runs land around 45-60s.
const REAL_FILE_TIMEOUT_MS = 90_000;

describe("extractTessDataStreams", () => {
  // Only one real fixture runs in the default suite, deliberately — see the
  // timeout comment above for why each one is this slow. Ground truth taken
  // by running research/d9-decode.py's own `collect` against this exact
  // file, not assumed; the byte length also matches FINDINGS.md section 5's
  // measured table.
  it(
    "recovers the one TessData stream in a real NIST part, byte-for-byte the size research/d9-decode.py finds",
    () => {
      const streams = extractTessDataStreams(
        readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
      );

      expect(streams).toHaveLength(1);
      expect(streams[0]?.length).toBe(287_403);
    },
    REAL_FILE_TIMEOUT_MS,
  );

  it("finds nothing in bytes that hold no compressed stream at all", () => {
    const plainBytes = new TextEncoder().encode(
      "not a SolidWorks file, no deflate anywhere in here",
    );

    expect(extractTessDataStreams(plainBytes)).toEqual([]);
  });

  it("finds nothing in an empty buffer", () => {
    expect(extractTessDataStreams(new Uint8Array(0))).toEqual([]);
  });

  it("recovers a stream nested two levels of compression deep", () => {
    const payload = tessDataPayload(1_000);
    const wrappedOnce = deflateRaw(payload);
    const wrappedTwice = deflate(wrappedOnce);

    expect(extractTessDataStreams(wrappedTwice)).toEqual([payload]);
  });

  it("dedupes byte-identical streams found at different offsets", () => {
    const payload = tessDataPayload(1_000);
    const compressed = deflate(payload);
    const bytes = new Uint8Array(compressed.length * 2);
    bytes.set(compressed, 0);
    bytes.set(compressed, compressed.length);

    expect(extractTessDataStreams(bytes)).toEqual([payload]);
  });

  it("discards a decompressed stream that doesn't contain the magic", () => {
    const withoutMagic = new Uint8Array(1_000).fill(0x42);
    const compressed = deflate(withoutMagic);

    expect(extractTessDataStreams(compressed)).toEqual([]);
  });
});
