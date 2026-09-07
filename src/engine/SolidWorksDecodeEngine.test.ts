import { readFileSync } from "node:fs";
import { deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import {
  decodeTessDataStream,
  extractTessDataStreams,
  SolidWorksDecodeEngine,
} from "./SolidWorksDecodeEngine";

const SOLIDWORKS_DIR = "assets/solidworks";
const TESS_DATA_MAGIC = "TessData";
const CHUNK_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const CHUNK_HEADER_SIZE = 0x1e;
const INLINE_F1 = 100_000;

function readSldprt(name: string): Uint8Array {
  return readFileSync(`${SOLIDWORKS_DIR}/${name}`);
}

/**
 * Non-compressible-looking bytes with the magic marker embedded midway
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

/** The exact inverse of production's rotate-left name cipher
 * (`SolidWorksContainerUtil.ts`'s `rolDecodeByte`). */
function rotateRightByte(byte: number, bits: number): number {
  const shift = bits & 7;
  if (shift === 0) {
    return byte;
  }
  return ((byte >>> shift) | (byte << (8 - shift))) & 0xff;
}

/**
 * Wraps `payload` in a minimal, real modern-container "file": an 8-byte
 * header (byte 7 is the ROL key) followed by one inline chunk —
 * `extractTessDataStreams` reads real file bytes, container envelope
 * included, not a bare deflate blob, so every fixture below needs to look
 * like one. `SolidWorksContainerUtil.test.ts` tests the chunk format itself
 * in detail; this only needs one chunk to drive `extractTessDataStreams`'s
 * own magic-sniffing and dedup behavior.
 */
function buildSolidWorksFile(
  chunks: readonly { name: string; payload: Uint8Array }[],
): Uint8Array {
  const key = 0x04; // matches every real sample file seen so far
  const chunkBytes = chunks.map(({ name, payload }) => {
    const compressed = deflateRaw(payload);
    const nameBytes = new TextEncoder().encode(name);
    const encodedName = Uint8Array.from(nameBytes, (b) =>
      rotateRightByte(b, key),
    );
    const bytes = new Uint8Array(
      CHUNK_HEADER_SIZE + encodedName.length + compressed.length,
    );
    const view = new DataView(bytes.buffer);
    bytes.set(CHUNK_MARKER, 4);
    view.setUint32(0x0e, INLINE_F1, true);
    view.setUint32(0x12, compressed.length, true);
    view.setUint32(0x16, payload.length, true);
    view.setUint32(0x1a, encodedName.length, true);
    bytes.set(encodedName, CHUNK_HEADER_SIZE);
    bytes.set(compressed, CHUNK_HEADER_SIZE + encodedName.length);
    return bytes;
  });
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

describe("extractTessDataStreams", () => {
  // D14 (WAYFINDER.md): this used to need a 90-second timeout — the
  // brute-force scan this function replaced took 45-60s per real NIST
  // part. The real container structure makes this fast enough that every
  // fixture, real files included, now runs at default `vitest` speed.
  it("recovers the one TessData stream in a real NIST part, byte-for-byte the size research/d9-decode.py finds", () => {
    const streams = extractTessDataStreams(
      readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]?.length).toBe(287_403);
  });

  it("finds nothing in bytes that hold no compressed stream at all", () => {
    const plainBytes = new TextEncoder().encode(
      "not a SolidWorks file, no deflate anywhere in here",
    );

    expect(extractTessDataStreams(plainBytes)).toEqual([]);
  });

  it("finds nothing in an empty buffer", () => {
    expect(extractTessDataStreams(new Uint8Array(0))).toEqual([]);
  });

  it("recovers a TessData chunk's decompressed payload from a real container", () => {
    const payload = tessDataPayload(1_000);
    const file = buildSolidWorksFile([
      { name: "Contents/DisplayLists", payload },
    ]);

    expect(extractTessDataStreams(file)).toEqual([payload]);
  });

  it("dedupes byte-identical chunks found under different names", () => {
    const payload = tessDataPayload(1_000);
    const file = buildSolidWorksFile([
      { name: "Contents/DisplayLists", payload },
      { name: "Contents/VBLists", payload },
    ]);

    expect(extractTessDataStreams(file)).toEqual([payload]);
  });

  it("discards a chunk whose decompressed payload doesn't contain the magic", () => {
    const withoutMagic = new Uint8Array(1_000).fill(0x42);
    const file = buildSolidWorksFile([
      { name: "Contents/DisplayLists", payload: withoutMagic },
    ]);

    expect(extractTessDataStreams(file)).toEqual([]);
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

  it("repairs a zero-length vertex normal from its own triangle's real geometry", () => {
    // A real customer part measured this session (DECISIONS.md) has this
    // exact pattern in every one of its 34 decoded blocks: the first
    // vertex of the first strip carries a stored normal of exactly
    // (0,0,0), which lights as if by ambient light alone, patchy against
    // its correctly-lit neighbors on the same triangle. Flat quad in the
    // XY plane, so the correct repaired normal is unambiguous: +Z.
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const normals = [0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.normals)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it("repairs both vertices when a strip's first two share one zero-length normal", () => {
    // The real part's own pattern sometimes zeroes strip-local offsets 0
    // *and* 1 (DECISIONS.md) — both share triangle k=0, so both must come
    // back correctly repaired from that one real triangle, not just the
    // first one found.
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const normals = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.normals)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it("leaves a vertex with no non-degenerate triangle unrepaired rather than guessing", () => {
    // All 4 positions collinear -- every triangle in the strip is
    // degenerate, so there is no real geometry to derive a normal from.
    const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];
    const normals = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(mesh.normals[0]).toBe(0);
    expect(mesh.normals[1]).toBe(0);
    expect(mesh.normals[2]).toBe(0);
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

  it("matches research/d9-decode.py's own vertex and triangle counts for a real NIST part", () => {
    const [stream] = extractTessDataStreams(
      readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
    );
    if (stream === undefined) {
      throw new Error("expected extractTessDataStreams to find a stream");
    }

    const mesh = decodeTessDataStream(stream);

    expect(mesh.positions).toHaveLength(4_196 * 3);
    expect(mesh.indices).toHaveLength(2_886 * 3);
  });

  it("accepts a block whose normals are smoothly blended along a curve, not all near-unit length", () => {
    // Modeled on a real gap this exact scenario caused (DECISIONS.md): a
    // real customer part's small tessellation strip along a filleted bend
    // had roughly half its normals measurably off from unit length (0.66-
    // 1.21), not the rare exception UNIT_NORMAL_TOLERANCE was originally
    // tuned for -- half the vertices here have length 0.7, comfortably
    // within the current 0.5 tolerance but not the original 0.05 one, so
    // this fails loudly if that tolerance ever regresses back down.
    const stripSizes = [6];
    const positions = Array.from({ length: 6 * 3 }, (_, i) => i * 0.01);
    const normals = [
      1, 0, 0, 0, 0, 0.7, 0, 1, 0, 0, 0, 0.7, 1, 0, 0, 0, 0, 0.7,
    ];
    const block = buildTessellationBlock(stripSizes, positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(Array.from(mesh.normals)).toEqual(
      normals.map((v) => Math.fround(v)),
    );
  });
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
    // No chunk marker anywhere in here, so extractModernContainerChunks
    // never finds anything to decompress in the first place.
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
    // A real TessData chunk (extractTessDataStreams will find and keep
    // it), but with no "4, 8, 2" header anywhere inside — so
    // decodeTessDataStream finds nothing to build a mesh from.
    const fileBytes = buildSolidWorksFile([
      { name: "Contents/DisplayLists", payload: tessDataPayload(1_000) },
    ]);

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
    const fileBytes = buildSolidWorksFile([
      { name: "Contents/DisplayLists", payload: withMagic },
    ]);

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

  it("reproduces the STEP-measured bounding box for a real NIST part, matching the already-committed demo/nist-ctc-01.json", () => {
    const model = new SolidWorksDecodeEngine().transform(
      readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
    );

    expect(model.diagnostics).toEqual([]);
    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0];
    if (mesh === undefined) {
      throw new Error("expected transform() to return one mesh");
    }
    expect(mesh.positions).toHaveLength(4_196 * 3);
    expect(mesh.indices).toHaveLength(2_886 * 3);

    // demo/nist-ctc-01.json (already committed — generated by
    // research/d9-decode.py, regenerated when UNIT_NORMAL_TOLERANCE
    // widened from 0.05 to 0.5) records this exact box: bboxMm [800.0,
    // 450.0, 150.0].
    const [gotX, gotY, gotZ] = extents(mesh.positions);
    expectWithinTolerance(gotX, 800.0);
    expectWithinTolerance(gotY, 450.0);
    expectWithinTolerance(gotZ, 150.0);
  });
});
