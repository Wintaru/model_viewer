import { describe, expect, it } from "vitest";
import { repairSmallGaps } from "./index";
import type { DecodedMesh, DecodedModel } from "../common";

type Vec3 = readonly [number, number, number];

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.sqrt(x * x + y * y + z * z);
  return [x / length, y / length, z / length];
}

const O: Vec3 = [0, 0, 0];
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

/**
 * A tetrahedron's four faces, each vertex order hand-verified (by taking
 * the cross product of its own two edges) to wind outward — away from the
 * solid's interior, matching the same right-hand convention this repo's
 * real decoders and `/repair` itself use. Each face gets its own 3 vertex
 * copies with that face's own flat normal, the same "independent per-face
 * tessellation" shape a real SolidWorks decode produces (ARCHITECTURE.md
 * section 6) — so building a mesh from a *subset* of these faces exercises
 * the same coincident-but-distinct-index seam this module exists to close,
 * not an artificial shortcut.
 */
const TETRAHEDRON_FACES: readonly {
  readonly corners: readonly [Vec3, Vec3, Vec3];
  readonly normal: Vec3;
}[] = [
  { corners: [O, Y, X], normal: [0, 0, -1] },
  { corners: [O, X, Z], normal: [0, -1, 0] },
  { corners: [O, Z, Y], normal: [-1, 0, 0] },
  { corners: [X, Y, Z], normal: normalize([1, 1, 1]) },
];

function buildTetrahedronMesh(faceIndices: readonly number[]): DecodedMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertexBase = 0;
  for (const faceIndex of faceIndices) {
    const face = TETRAHEDRON_FACES[faceIndex];
    if (face === undefined) {
      throw new Error(`No such tetrahedron face: ${faceIndex}`);
    }
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    indices.push(vertexBase, vertexBase + 1, vertexBase + 2);
    vertexBase += 3;
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    faces: [],
  };
}

/**
 * A flat `size`x`size` grid of unit squares in the z=0 plane, each split
 * into two CCW-wound (viewed from +Z) triangles. Always has its own outer
 * perimeter as a boundary — a flat sheet is never a closed solid — so this
 * is only used below to build a *branching* boundary (two gaps meeting at
 * one shared corner), never for an "already watertight" case.
 */
function buildGridMesh(
  size: number,
  missingQuads: readonly (readonly [number, number])[],
): DecodedMesh {
  const missing = new Set(missingQuads.map(([x, y]) => `${x},${y}`));
  const stride = size + 1;
  const positions = new Float32Array(stride * stride * 3);
  const normals = new Float32Array(stride * stride * 3);
  for (let y = 0; y <= size; y++) {
    for (let x = 0; x <= size; x++) {
      const i = y * stride + x;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = 0;
      normals[i * 3 + 2] = 1;
    }
  }
  const vertexIndex = (x: number, y: number) => y * stride + x;
  const indices: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (missing.has(`${x},${y}`)) {
        continue;
      }
      const bl = vertexIndex(x, y);
      const br = vertexIndex(x + 1, y);
      const tr = vertexIndex(x + 1, y + 1);
      const tl = vertexIndex(x, y + 1);
      indices.push(bl, br, tr, bl, tr, tl);
    }
  }
  return {
    positions,
    normals,
    indices: Uint32Array.from(indices),
    faces: [],
  };
}

function modelWith(mesh: DecodedMesh): DecodedModel {
  return {
    units: "mm",
    meshes: [mesh],
    tree: [],
    metadata: {},
    diagnostics: [],
  };
}

/** Every edge of a closed surface belongs to exactly two triangles, once
 * coincident-but-distinct vertex copies at a seam are treated as the same
 * point — snapping by exact position (these fixtures use exact repeated
 * float values, not noisy real-world ones) mirrors the real module's own
 * canonicalization closely enough for a test oracle. */
function boundaryEdgeCount(mesh: DecodedMesh): number {
  const key = (i: number) =>
    `${mesh.positions[i * 3] ?? 0},${mesh.positions[i * 3 + 1] ?? 0},${mesh.positions[i * 3 + 2] ?? 0}`;
  const count = new Map<string, number>();
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const tri = [
      mesh.indices[t] ?? 0,
      mesh.indices[t + 1] ?? 0,
      mesh.indices[t + 2] ?? 0,
    ].map(key);
    for (let e = 0; e < 3; e++) {
      const a = tri[e] ?? "";
      const b = tri[(e + 1) % 3] ?? "";
      const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(edgeKey, (count.get(edgeKey) ?? 0) + 1);
    }
  }
  return [...count.values()].filter((c) => c === 1).length;
}

function triangleNormal(
  mesh: DecodedMesh,
  triangleIndex: number,
): [number, number, number] {
  const ia = mesh.indices[triangleIndex * 3] ?? 0;
  const ib = mesh.indices[triangleIndex * 3 + 1] ?? 0;
  const ic = mesh.indices[triangleIndex * 3 + 2] ?? 0;
  const p = (i: number): [number, number, number] => [
    mesh.positions[i * 3] ?? 0,
    mesh.positions[i * 3 + 1] ?? 0,
    mesh.positions[i * 3 + 2] ?? 0,
  ];
  const [ax, ay, az] = p(ia);
  const [bx, by, bz] = p(ib);
  const [cx, cy, cz] = p(ic);
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

describe("repairSmallGaps", () => {
  it("leaves an already-watertight mesh, and the model, unchanged", () => {
    const mesh = buildTetrahedronMesh([0, 1, 2, 3]);
    expect(boundaryEdgeCount(mesh)).toBe(0);
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model);

    expect(repaired.meshes[0]).toBe(mesh);
    expect(repaired.diagnostics).toHaveLength(0);
  });

  it("fills a small gap using only its own boundary vertices, restoring watertightness", () => {
    // Face 3 (X,Y,Z) omitted -- a real triangular gap bounded by the other
    // three faces' own (independently-tessellated) edge vertices.
    const mesh = buildTetrahedronMesh([0, 1, 2]);
    expect(boundaryEdgeCount(mesh)).toBe(3);
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model, { maxRelativeGapSize: 1 });

    const repairedMesh = repaired.meshes[0];
    expect(repairedMesh).toBeDefined();
    if (repairedMesh === undefined) {
      return;
    }
    // 3-vertex loop -> 1 new centroid vertex, 3 new fan triangles.
    expect(repairedMesh.positions.length).toBe(mesh.positions.length + 3);
    expect(repairedMesh.indices.length).toBe(mesh.indices.length + 3 * 3);
    expect(boundaryEdgeCount(repairedMesh)).toBe(0);

    expect(
      repaired.diagnostics.some(
        (d) =>
          d.code === "gap-repair-filled" &&
          d.message.includes("Filled 1 small gap") &&
          d.message.includes("3 patch triangle"),
      ),
    ).toBe(true);
  });

  it("orients patch triangles outward, matching the surrounding surface's own normal", () => {
    // The concrete case this guards: fanning a hole boundary with the
    // vertices in the order the boundary edges are naturally found
    // produces an INVERTED (inward-facing) patch -- verified by hand
    // against a concrete flat-hole example (DECISIONS.md). This test fails
    // loudly if that reversal ever regresses.
    const mesh = buildTetrahedronMesh([0, 1, 2]);
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model, { maxRelativeGapSize: 1 });
    const repairedMesh = repaired.meshes[0];
    expect(repairedMesh).toBeDefined();
    if (repairedMesh === undefined) {
      return;
    }

    const originalTriangleCount = mesh.indices.length / 3;
    const totalTriangleCount = repairedMesh.indices.length / 3;
    expect(totalTriangleCount).toBeGreaterThan(originalTriangleCount);

    // The removed face's own known-correct outward normal (from the fixture
    // table above) is the ground truth every patch triangle must agree
    // with in sign, since together they replace exactly that one face.
    const expectedNormal = TETRAHEDRON_FACES[3]?.normal;
    expect(expectedNormal).toBeDefined();
    if (expectedNormal === undefined) {
      return;
    }
    for (let t = originalTriangleCount; t < totalTriangleCount; t++) {
      const n = triangleNormal(repairedMesh, t);
      const dot =
        n[0] * expectedNormal[0] +
        n[1] * expectedNormal[1] +
        n[2] * expectedNormal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("skips a gap too large relative to the model's own size, and reports it instead of guessing", () => {
    const mesh = buildTetrahedronMesh([0, 1, 2]);
    const model = modelWith(mesh);

    // Default cap (5%) -- one face of a 4-face solid is far larger than
    // that relative to the whole tetrahedron, so it must be left alone.
    const repaired = repairSmallGaps(model);

    expect(repaired.meshes[0]).toEqual(mesh);
    expect(
      repaired.diagnostics.some(
        (d) => d.code === "gap-repair-skipped-large-gap",
      ),
    ).toBe(true);
    expect(
      repaired.diagnostics.some((d) => d.code === "gap-repair-filled"),
    ).toBe(false);
  });

  it("reports, rather than guesses at, a boundary vertex shared by two unrelated gaps", () => {
    // Two missing quads touching at exactly one corner (2,2) -- that
    // corner sees boundary edges from both holes, so it has no single
    // well-defined "next" vertex around either loop. maxRelativeGapSize: 0
    // additionally guarantees nothing at all gets patched (including the
    // grid's own always-present outer perimeter), isolating this test to
    // just the branching-vertex detection.
    const mesh = buildGridMesh(4, [
      [1, 1],
      [2, 2],
    ]);
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model, { maxRelativeGapSize: 0 });

    expect(repaired.meshes[0]?.indices.length).toBe(mesh.indices.length);
    expect(
      repaired.diagnostics.some(
        (d) => d.code === "gap-repair-skipped-ambiguous-boundary",
      ),
    ).toBe(true);
  });

  it("passes a 'lines' mesh through unchanged", () => {
    const mesh: DecodedMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      normals: new Float32Array([0, 0, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1]),
      faces: [],
      topology: "lines",
    };
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model);

    expect(repaired.meshes[0]).toBe(mesh);
  });

  it("covers the original geometry with one FaceRange and gives the patch a distinct colour", () => {
    const mesh = buildTetrahedronMesh([0, 1, 2]);
    const model = modelWith(mesh);

    const repaired = repairSmallGaps(model, { maxRelativeGapSize: 1 });
    const repairedMesh = repaired.meshes[0];
    expect(repairedMesh).toBeDefined();
    if (repairedMesh === undefined) {
      return;
    }

    const originalTriangleCount = mesh.indices.length / 3;
    const totalTriangleCount = repairedMesh.indices.length / 3;
    expect(repairedMesh.faces).toEqual([
      { id: 0, start: 0, count: originalTriangleCount * 3 },
      {
        id: 1,
        start: originalTriangleCount * 3,
        count: (totalTriangleCount - originalTriangleCount) * 3,
        color: [1, 0.55, 0],
      },
    ]);
  });

  it("assigns the patch a fresh id after a mesh that already tracks per-face identity", () => {
    const mesh = buildTetrahedronMesh([0, 1, 2]);
    const originalTriangleCount = mesh.indices.length / 3;
    const meshWithFaces: DecodedMesh = {
      ...mesh,
      faces: [{ id: 5, start: 0, count: originalTriangleCount * 3 }],
    };
    const model = modelWith(meshWithFaces);

    const repaired = repairSmallGaps(model, { maxRelativeGapSize: 1 });
    const repairedMesh = repaired.meshes[0];
    expect(repairedMesh).toBeDefined();
    if (repairedMesh === undefined) {
      return;
    }

    expect(repairedMesh.faces).toHaveLength(2);
    expect(repairedMesh.faces[0]).toEqual({
      id: 5,
      start: 0,
      count: originalTriangleCount * 3,
    });
    expect(repairedMesh.faces[1]?.id).toBe(6);
  });
});
