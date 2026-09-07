import { existsSync, readFileSync } from "node:fs";
import { deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import {
  decodeTessDataStream,
  extractTessDataStreams,
  SolidWorksDecodeEngine,
} from "./SolidWorksDecodeEngine.js";

const SOLIDWORKS_DIR = "assets/solidworks";
const TESS_DATA_MAGIC = "TessData";
const CHUNK_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const CHUNK_HEADER_SIZE = 0x1e;
const INLINE_F1 = 100_000;

function readSldprt(name: string): Uint8Array {
  return readFileSync(`${SOLIDWORKS_DIR}/${name}`);
}

// The test corpus is not in git — `pnpm assets` fetches it (assets/README.md).
// A case that needs it skips when it is absent, rather than failing, so a
// fresh clone can run `pnpm test` and get a meaningful result. CI restores the
// corpus from cache and fetches it on a miss, so these cases really do run
// there — see .github/workflows/ci.yml.
const itWithCorpus = it.skipIf(
  !existsSync(`${SOLIDWORKS_DIR}/nist_ctc_01_asme1_rd_sw1802.SLDPRT`),
);

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
  itWithCorpus(
    "recovers the one TessData stream in a real NIST part, byte-for-byte the size research/d9-decode.py finds",
    () => {
      const streams = extractTessDataStreams(
        readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
      );

      expect(streams).toHaveLength(1);
      expect(streams[0]?.length).toBe(287_403);
    },
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

  it("recovers a real assembly's per-component chunk by its FaceTessellations/ name, even without the TessData magic", () => {
    // DECISIONS.md D20: a real assembly's own `Contents/DisplayLists` does
    // carry the `TessData` substring, but only in unrelated display-state
    // tags -- its actual per-component tessellation lives in a separate
    // `FaceTessellations/<id>` chunk that carries no such substring at all,
    // so this can only be found by chunk name, not content-sniffing.
    const withoutMagic = new Uint8Array(1_000).fill(0x42);
    const file = buildSolidWorksFile([
      { name: "FaceTessellations/000-000-005", payload: withoutMagic },
    ]);

    expect(extractTessDataStreams(file)).toEqual([withoutMagic]);
  });

  it("still discards an unrelated chunk with neither the magic nor a FaceTessellations/ name", () => {
    const withoutMagic = new Uint8Array(1_000).fill(0x42);
    const file = buildSolidWorksFile([
      { name: "Contents/CusProps", payload: withoutMagic },
    ]);

    expect(extractTessDataStreams(file)).toEqual([]);
  });
});

/**
 * Hand-builds one tessellation block, ARCHITECTURE.md section 6's record
 * layout: `4, 8, 2, N`, then N strip sizes, then the tail `a, b, 2, TOTAL`
 * (the literal `2` immediately before `TOTAL` is load-bearing — see
 * `findWordAfterTotalMarker` — so this writes the real four-word tail
 * rather than `TOTAL` alone). `a`/`b` are arbitrary filler: nothing reads
 * them.
 */
function buildTessellationBlock(
  stripSizes: readonly number[],
  positions: readonly number[],
  normals: readonly number[],
): Uint8Array {
  const total = stripSizes.reduce((sum, size) => sum + size, 0);
  const wordCount =
    4 + stripSizes.length + 4 + positions.length + normals.length;
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
  for (const tailWord of [12, 100, 2, total]) {
    view.setUint32(word * 4, tailWord, true);
    word += 1;
  }
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

function normalizeForTest(v: readonly number[]): number[] {
  const length = Math.sqrt(v.reduce((sum, c) => sum + c * c, 0));
  return v.map((c) => c / length);
}

/** float32 round-tripping plus the crease-angle averaging itself leaves a
 * little room for error, so component-wise closeness beats exact equality
 * for every hand-derived expected normal below. */
function expectVectorClose(
  got: readonly number[],
  want: readonly number[],
): void {
  expect(got).toHaveLength(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(got[i]).toBeCloseTo(want[i] ?? 0, 4);
  }
}

describe("decodeTessDataStream", () => {
  it("builds triangle strips, not fans, with alternating winding", () => {
    const stripSizes = [4, 5];
    const vertexCount = 9;
    // Collinear positions -- every triangle here is degenerate, so this
    // exercises indices/winding only; normals are covered by the
    // dedicated tests below.
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
    expect(Array.from(mesh.normals)).toEqual(
      new Array(vertexCount * 3).fill(0),
    );
    // Strip of 4 (vertices 0-3): [0,1,2], [2,1,3] — fanning from vertex 0
    // would instead give [0,1,2],[0,2,3], which this must NOT match.
    // Strip of 5 (vertices 4-8): [4,5,6],[6,5,7],[6,7,8].
    expect(Array.from(mesh.indices)).toEqual([
      0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 6, 7, 8,
    ]);
  });

  it("computes a flat quad's normal from its own triangle geometry, ignoring whatever the file stored", () => {
    // Normals are never read from the file at all (DECISIONS.md) -- every
    // vertex normal is regenerated from the decoded triangle positions, so
    // a stored value of exactly zero (a real, measured pattern in every
    // one of a real customer part's 34 decoded blocks) is no different
    // from any other stored garbage: it's simply never consulted. Flat
    // quad in the XY plane, so the correct normal is unambiguous: +Z.
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const normals = [0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.normals)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it("computes the same flat normal regardless of which stored values happened to be zero", () => {
    // Same flat quad, different (still-irrelevant) stored values -- proves
    // the previous test's result isn't an accident of which specific
    // vertex happened to carry a zero.
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const normals = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.normals)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it("leaves a vertex with no non-degenerate triangle at (0,0,0) rather than guessing", () => {
    // All 4 positions collinear -- every triangle in the strip is
    // degenerate, so there is no real geometry to derive a normal from.
    const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];
    const normals = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
    const block = buildTessellationBlock([4], positions, normals);

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.normals)).toEqual(new Array(12).fill(0));
  });

  it("blends normals across a shared edge within one block when the crease angle is gentle", () => {
    // Two flat quads (as two strips of one block) sharing an edge, the
    // second tilted 10 degrees from the first around that shared edge --
    // comfortably under the 45-degree crease threshold, so this reads as
    // one continuous, gently curved surface split into two strips (a real
    // pattern SolidWorks's own tessellation uses for a fillet or a
    // cylindrical wall). Every value below is hand-derived from the exact
    // geometry, not just asserted against the implementation.
    const tiltRad = (10 * Math.PI) / 180;
    const sin10 = Math.sin(tiltRad);
    const cos10 = Math.cos(tiltRad);
    const positions = [
      // Strip 1 (vertices 0-3): flat quad in the XY plane, normal +Z.
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      1,
      1,
      0,
      // Strip 2 (vertices 4-7): its own copies of the shared edge
      // (0,1,0)/(1,1,0) -- this format never shares literal indices
      // across strips, even within one block -- then the far edge
      // rotated 10 degrees around that shared edge (the X axis at y=1).
      0,
      1,
      0,
      1,
      1,
      0,
      0,
      1 + cos10,
      sin10,
      1,
      1 + cos10,
      sin10,
    ];
    const block = buildTessellationBlock([4, 4], positions, unitNormals(8));

    const mesh = decodeTessDataStream(block);
    const normals = Array.from(mesh.normals);

    // Vertices 0 and 1 (strip 1 only, not on the shared edge) keep +Z.
    expectVectorClose(normals.slice(0, 3), [0, 0, 1]);
    expectVectorClose(normals.slice(3, 6), [0, 0, 1]);
    // Vertices 6 and 7 (strip 2 only, not on the shared edge) keep the
    // strip's own tilted direction.
    expectVectorClose(normals.slice(18, 21), [0, -sin10, cos10]);
    expectVectorClose(normals.slice(21, 24), [0, -sin10, cos10]);
    // The shared edge (vertices 2 and 4, both at (0,1,0)) blends both
    // strips' triangles that touch it: 2 from strip 1's own flat quad
    // plus 1 from strip 2, normalize(0, -sin10, 2+cos10).
    const blendA = normalizeForTest([0, -sin10, 2 + cos10]);
    expectVectorClose(normals.slice(6, 9), blendA);
    expectVectorClose(normals.slice(12, 15), blendA);
    // The other shared edge (vertices 3 and 5, both at (1,1,0)) blends 1
    // triangle from strip 1 plus 2 from strip 2:
    // normalize(0, -2*sin10, 1+2*cos10).
    const blendB = normalizeForTest([0, -2 * sin10, 1 + 2 * cos10]);
    expectVectorClose(normals.slice(9, 12), blendB);
    expectVectorClose(normals.slice(15, 18), blendB);
  });

  it("keeps a sharp edge crisp within one block instead of blending across it", () => {
    // Same construction as the gentle-crease test above, but tilted a
    // full 90 degrees -- a genuine sharp edge (a sheet-metal bend), well
    // past the 45-degree crease threshold. Neither strip's own vertices
    // should be pulled towards the other's direction at all.
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1,
    ];
    const block = buildTessellationBlock([4, 4], positions, unitNormals(8));

    const mesh = decodeTessDataStream(block);
    const normals = Array.from(mesh.normals);

    // Every strip-1 vertex, including the two on the shared edge, keeps
    // strip 1's own flat +Z -- completely unaffected by strip 2.
    for (const [start, end] of [
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 12],
    ] as const) {
      expectVectorClose(normals.slice(start, end), [0, 0, 1]);
    }
    // Every strip-2 vertex keeps strip 2's own flat direction (-Y),
    // completely unaffected by strip 1.
    for (const [start, end] of [
      [12, 15],
      [15, 18],
      [18, 21],
      [21, 24],
    ] as const) {
      expectVectorClose(normals.slice(start, end), [0, -1, 0]);
    }
  });

  it("never blends normals across two different tessellation blocks, even at a shared, gently-angled edge", () => {
    // The exact same 10-degree geometry as the gentle-crease test above --
    // but as two SEPARATE blocks (two concatenated tessellation records)
    // instead of two strips of one block. Unlike that test, nothing here
    // should blend: welding is scoped to one block only (DECISIONS.md --
    // a real NIST calibration part showed globally-welded positions
    // letting an unrelated block drag a genuinely flat block's normal
    // towards a completely different face).
    const tiltRad = (10 * Math.PI) / 180;
    const sin10 = Math.sin(tiltRad);
    const cos10 = Math.cos(tiltRad);
    const block1 = buildTessellationBlock(
      [4],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      unitNormals(4),
    );
    const block2 = buildTessellationBlock(
      [4],
      [0, 1, 0, 1, 1, 0, 0, 1 + cos10, sin10, 1, 1 + cos10, sin10],
      unitNormals(4),
    );
    const combined = new Uint8Array(block1.length + block2.length);
    combined.set(block1, 0);
    combined.set(block2, block1.length);

    const mesh = decodeTessDataStream(combined);
    const normals = Array.from(mesh.normals);

    for (let vertex = 0; vertex < 4; vertex++) {
      expectVectorClose(normals.slice(vertex * 3, vertex * 3 + 3), [0, 0, 1]);
    }
    for (let vertex = 4; vertex < 8; vertex++) {
      expectVectorClose(normals.slice(vertex * 3, vertex * 3 + 3), [
        0,
        -sin10,
        cos10,
      ]);
    }
  });

  it("finds nothing in bytes with no valid tessellation header", () => {
    const mesh = decodeTessDataStream(new Uint8Array(1_000));

    expect(mesh.positions).toHaveLength(0);
    expect(mesh.normals).toHaveLength(0);
    expect(mesh.indices).toHaveLength(0);
  });

  it("rejects a header whose strip sizes don't add up to the tail's total", () => {
    // A hand-corrupted block: claims total 9 in the header dance, but the
    // tail's own total word is a different value, so the "does the tail
    // contain the total, right after a literal 2" search never matches.
    const block = buildTessellationBlock(
      [4, 5],
      Array.from({ length: 27 }, (_, i) => i * 0.01),
      unitNormals(9),
    );
    // Word 9 -- header(4) + 2 strip sizes + tail's a, b, 2 -- holds the
    // tail's total (9); corrupt it so no window search can find a match.
    new DataView(block.buffer).setUint32(9 * 4, 999, true);

    const mesh = decodeTessDataStream(block);

    expect(mesh.indices).toHaveLength(0);
  });

  it("decodes a block correctly even when its own vertex total equals the tail's leading constant", () => {
    // Regression test: a real customer part had three small blocks that
    // each tessellated to exactly 12 vertices -- the same value as `12`,
    // the tail's own leading (otherwise-unused) constant word. Matching
    // `findWordAfterTotalMarker` on the vertex total alone, without also
    // requiring the literal `2` immediately before it, locked onto that
    // leading constant instead of the real total three words later,
    // silently shifting every position/normal float read for the block.
    // `buildTessellationBlock` always writes a real `12, 100, 2, TOTAL`
    // tail, so this only needs a block whose own total is 12 to exercise
    // the collision.
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 2, 1, 0, 3, 0, 0, 3, 1, 0, 4,
      0, 0, 4, 1, 0, 5, 0, 0, 5, 1, 0,
    ];
    const block = buildTessellationBlock([4, 8], positions, unitNormals(12));

    const mesh = decodeTessDataStream(block);

    expect(Array.from(mesh.positions)).toEqual(positions);
  });

  itWithCorpus(
    "matches research/d9-decode.py's own vertex and triangle counts for a real NIST part",
    () => {
      const [stream] = extractTessDataStreams(
        readSldprt("nist_ctc_01_asme1_rd_sw1802.SLDPRT"),
      );
      if (stream === undefined) {
        throw new Error("expected extractTessDataStreams to find a stream");
      }

      const mesh = decodeTessDataStream(stream);

      expect(mesh.positions).toHaveLength(4_196 * 3);
      expect(mesh.indices).toHaveLength(2_886 * 3);
    },
  );

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

    // The block must still be *found* (scan acceptance is what
    // UNIT_NORMAL_TOLERANCE governs) -- the stored normals asserted above
    // are never read for the output mesh itself (DECISIONS.md), and these
    // particular positions are collinear, so the correct synthesized
    // result is all-zero (no non-degenerate triangle exists).
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(Array.from(mesh.normals)).toEqual(new Array(6 * 3).fill(0));
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
    // These positions are collinear (same as every other winding-focused
    // fixture in this file), so every triangle is degenerate and the
    // correctly-synthesized normal is all-zero -- this test's own focus is
    // the millimetre conversion and end-to-end wiring, not normals.
    expect(Array.from(mesh.normals)).toEqual(
      new Array(vertexCount * 3).fill(0),
    );
    expect(Array.from(mesh.indices)).toEqual(expectedStripIndices(stripSizes));
    expect(mesh.faces).toEqual([]);
    expect(model.tree).toEqual([{ meshIndices: [0], children: [] }]);
  });

  itWithCorpus(
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
    },
  );
});
