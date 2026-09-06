import { readFileSync } from "node:fs";
import { deflate, deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import {
  decodeTessDataStream,
  extractTessDataStreams,
} from "./SolidWorksDecodeEngine";

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

/**
 * Hand-builds one tessellation block, ARCHITECTURE.md section 6's record
 * layout: `4, 8, 2, N`, then N strip sizes, then a tail whose only
 * requirement (`research/d9-decode.py`'s `_scan`) is that the vertex total
 * appears somewhere in the next few words — placed immediately after the
 * sizes here, the simplest layout the scanner accepts.
 */
function buildTessellationBlock(
  stripSizes: readonly number[],
  positions: readonly number[],
  normals: readonly number[],
): Uint8Array {
  const total = stripSizes.reduce((sum, size) => sum + size, 0);
  const wordCount =
    4 + stripSizes.length + 1 + positions.length + normals.length;
  const bytes = new Uint8Array(wordCount * 4);
  const view = new DataView(bytes.buffer);

  let word = 0;
  for (const marker of [4, 8, 2, stripSizes.length]) {
    view.setUint32(word * 4, marker, true);
    word += 1;
  }
  for (const size of stripSizes) {
    view.setUint32(word * 4, size, true);
    word += 1;
  }
  view.setUint32(word * 4, total, true);
  word += 1;
  for (const value of [...positions, ...normals]) {
    view.setFloat32(word * 4, value, true);
    word += 1;
  }
  return bytes;
}

const UNIT_AXES = 3;

/** Cycles through the three coordinate-axis unit vectors, always length 1. */
function unitNormals(vertexCount: number): number[] {
  const normals: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const axis = i % UNIT_AXES;
    normals.push(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  }
  return normals;
}

describe("decodeTessDataStream", () => {
  it("builds triangle strips, not fans, with alternating winding", () => {
    const stripSizes = [4, 5];
    const vertexCount = 9;
    const positions = Array.from(
      { length: vertexCount * 3 },
      (_, i) => i * 0.01,
    );
    const normals = unitNormals(vertexCount);
    const block = buildTessellationBlock(stripSizes, positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.positions)).toEqual(
      positions.map((v) => Math.fround(v)),
    );
    expect(Array.from(mesh.normals)).toEqual(normals);
    // Strip of 4 (vertices 0-3): [0,1,2], [2,1,3] — fanning from vertex 0
    // would instead give [0,1,2],[0,2,3], which this must NOT match.
    // Strip of 5 (vertices 4-8): [4,5,6],[6,5,7],[6,7,8].
    expect(Array.from(mesh.indices)).toEqual([
      0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 6, 7, 8,
    ]);
  });

  it("finds nothing in bytes with no valid tessellation header", () => {
    const mesh = decodeTessDataStream(new Uint8Array(1_000));

    expect(mesh.positions).toHaveLength(0);
    expect(mesh.normals).toHaveLength(0);
    expect(mesh.indices).toHaveLength(0);
  });

  it("rejects a header whose strip sizes don't add up to the tail's total", () => {
    // A hand-corrupted block: claims total 9 in the header dance, but the
    // tail word placed right after the sizes is a different value, so the
    // "does the tail contain the total" search never matches.
    const block = buildTessellationBlock(
      [4, 5],
      Array.from({ length: 27 }, (_, i) => i * 0.01),
      unitNormals(9),
    );
    // Word 6 (right after the 2 strip sizes) holds the tail total (9) —
    // corrupt it so no window search can find a match.
    new DataView(block.buffer).setUint32(6 * 4, 999, true);

    const mesh = decodeTessDataStream(block);

    expect(mesh.indices).toHaveLength(0);
  });

  it(
    "matches research/d9-decode.py's own vertex and triangle counts for a real NIST part",
    () => {
      const [stream] = extractTessDataStreams(
        readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
      );
      if (stream === undefined) {
        throw new Error("expected extractTessDataStreams to find a stream");
      }

      const mesh = decodeTessDataStream(stream);

      expect(mesh.positions).toHaveLength(3_396 * 3);
      expect(mesh.indices).toHaveLength(2_296 * 3);
    },
    REAL_FILE_TIMEOUT_MS,
  );
});
