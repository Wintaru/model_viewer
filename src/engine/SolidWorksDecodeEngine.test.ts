import { readFileSync } from "node:fs";
import { deflate, deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import {
  decodeTessDataStream,
  extractTessDataStreams,
  SolidWorksDecodeEngine,
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

/** Independently re-derives the strip-triangulation rule (ARCHITECTURE.md
 * section 6) from its spec, rather than reusing assembleMesh's own code, so
 * this actually cross-checks production behavior instead of restating it. */
function expectedStripIndices(stripSizes: readonly number[]): number[] {
  const indices: number[] = [];
  let base = 0;
  for (const size of stripSizes) {
    for (let k = 0; k < size - 2; k++) {
      if (k % 2 === 0) {
        indices.push(base + k, base + k + 1, base + k + 2);
      } else {
        indices.push(base + k + 1, base + k, base + k + 2);
      }
    }
    base += size;
  }
  return indices;
}

/** Per-axis extents (max - min), the same shape research/d9-verify-cached.py
 * compares against d8-truth.json's independently STEP-measured boxes.
 * Streams rather than indexes into `positions`, same reason
 * normalsLookValid does in the production code. */
function extents(positions: Float32Array): readonly [number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let component = 0;
  let x = 0;
  let y = 0;
  for (const value of positions) {
    if (component === 0) {
      x = value;
    } else if (component === 1) {
      y = value;
    } else {
      const z = value;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    component = (component + 1) % 3;
  }
  return [maxX - minX, maxY - minY, maxZ - minZ];
}

/** Same 2%-or-0.5mm tolerance research/d9-verify-cached.py uses to compare
 * against independently STEP-measured boxes. */
function expectWithinTolerance(got: number, want: number): void {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.max(0.5, 0.02 * want));
}

describe("SolidWorksDecodeEngine", () => {
  it("reports no-tessdata-found for a file with no compressed stream at all", () => {
    const engine = new SolidWorksDecodeEngine();
    // No valid zlib or raw-deflate stream anywhere in here, so
    // tryInflateAt never succeeds at any offset — MIN_ACCEPTED_OUTPUT_BYTES
    // never even comes into play, since that only gates a *successful*
    // inflate's output length, not the raw input.
    const plainBytes = new TextEncoder().encode(
      "not a SolidWorks file, no deflate stream anywhere in here",
    );

    const model = engine.transform(plainBytes);

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "no-tessdata-found",
      }),
    );
  });

  it("reports tessdata-decode-failed when a stream is found but no tessellation block decodes from it", () => {
    // A real TessData stream (extractTessDataStreams will find and keep
    // it), but with no "4, 8, 2" header anywhere inside — so
    // decodeTessDataStream finds nothing to build a mesh from.
    const fileBytes = deflate(tessDataPayload(1_000));

    const model = new SolidWorksDecodeEngine().transform(fileBytes);

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "tessdata-decode-failed",
      }),
    );
  });

  it("decodes a synthetic file end to end, converting metres to millimetres", () => {
    const stripSizes = [10, 10];
    const vertexCount = 20;
    // Small metre-scale values, matching FINDINGS.md section 5's claim that
    // SolidWorks tessellation coordinates are metres, not millimetres.
    const positionsMetres = Array.from(
      { length: vertexCount * 3 },
      (_, i) => i * 0.001,
    );
    const normals = unitNormals(vertexCount);
    const block = buildTessellationBlock(stripSizes, positionsMetres, normals);
    const withMagic = new Uint8Array(TESS_DATA_MAGIC.length + block.length);
    withMagic.set(new TextEncoder().encode(TESS_DATA_MAGIC), 0);
    withMagic.set(block, TESS_DATA_MAGIC.length);
    const fileBytes = deflate(withMagic);

    const model = new SolidWorksDecodeEngine().transform(fileBytes);

    expect(model.units).toBe("mm");
    expect(model.diagnostics).toEqual([]);
    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0];
    if (mesh === undefined) {
      throw new Error("expected transform() to return one mesh");
    }

    // float32 round-trips twice — once writing the synthetic fixture,
    // once through the *1000 conversion — so both roundings are replayed
    // here rather than comparing against full double precision.
    expect(Array.from(mesh.positions)).toEqual(
      positionsMetres.map((v) => Math.fround(Math.fround(v) * 1000)),
    );
    expect(Array.from(mesh.normals)).toEqual(normals);
    expect(Array.from(mesh.indices)).toEqual(expectedStripIndices(stripSizes));
    expect(mesh.faces).toEqual([]);
    expect(model.tree).toEqual([{ meshIndices: [0], children: [] }]);
  });

  it(
    "reproduces the STEP-measured bounding box for a real NIST part, matching the already-committed demo/nist-ctc-01.json",
    () => {
      const model = new SolidWorksDecodeEngine().transform(
        readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
      );

      expect(model.diagnostics).toEqual([]);
      expect(model.meshes).toHaveLength(1);
      const mesh = model.meshes[0];
      if (mesh === undefined) {
        throw new Error("expected transform() to return one mesh");
      }
      expect(mesh.positions).toHaveLength(3_396 * 3);
      expect(mesh.indices).toHaveLength(2_296 * 3);

      // demo/nist-ctc-01.json (already committed — generated by
      // research/d9-decode.py) records this exact box: bboxMm [800.0,
      // 450.0, 150.0].
      const [gotX, gotY, gotZ] = extents(mesh.positions);
      expectWithinTolerance(gotX, 800.0);
      expectWithinTolerance(gotY, 450.0);
      expectWithinTolerance(gotZ, 150.0);
    },
    REAL_FILE_TIMEOUT_MS,
  );
});
