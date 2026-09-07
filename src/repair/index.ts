import type {
  DecodedMesh,
  DecodedModel,
  Diagnostic,
  FaceRange,
} from "../common";

/**
 * The `/repair` entry point (WAYFINDER.md D15). A pure, stateless transform
 * from one {@link DecodedModel} to another — the same "kept out of the
 * package root, depends only on Common" shape `/three` and `/2d` already
 * establish (ARCHITECTURE.md section 2), for the same reason: a caller
 * doing headless work never needs this either, so it isn't pulled in for
 * free.
 *
 * What this fixes: SolidWorks tessellates each CAD face independently, and
 * two faces meeting at a shared curve (a hole wall against the flat face it
 * cuts into, say) don't always sample that shared curve identically — the
 * two faces' cached triangles leave a sliver of un-shared boundary between
 * them even though the solid itself has no actual opening there. Real
 * viewers paper over this; this module is the same idea, done explicitly
 * and disclosed rather than silently: it finds small boundary loops (edges
 * used by only one triangle, where a closed solid's surface should use
 * every edge twice) and caps them with a triangle fan built ONLY from
 * vertices the decode already produced — never inventing a position that
 * didn't come from the file. A loop too large, relative to the model's own
 * size, to plausibly be this kind of seam is left alone and reported
 * instead of guessed at (CLAUDE.md: "measured, not assumed").
 */

/** Options for {@link repairSmallGaps}. */
export interface GapRepairOptions {
  /**
   * A boundary loop is only patched when its own bounding diagonal is no
   * more than this fraction of the whole model's bounding diagonal.
   * Relative, not a fixed mm figure, so the same default behaves sensibly
   * whether the model is a small bracket or a large housing. Default 0.05
   * (5%).
   */
  readonly maxRelativeGapSize?: number;
}

const DEFAULT_MAX_RELATIVE_GAP_SIZE = 0.05;

/**
 * Coincident vertices at a tessellation seam are numerically close, not
 * bit-identical (independent per-face triangulation, each with its own
 * floating-point rounding) — 1 micron in `DecodedModel`'s millimetre units
 * merges true duplicates without merging two genuinely distinct nearby
 * vertices.
 */
const VERTEX_SNAP_EPSILON_MM = 1e-3;

/**
 * A visually distinct tint for patch triangles, so a repaired region stays
 * identifiable rather than blending silently into real geometry — the same
 * disclosure principle as the diagnostics this function emits.
 */
const PATCH_COLOR: readonly [number, number, number] = [1, 0.55, 0];

/**
 * Finds small gaps in each triangle mesh's surface — boundary edges left by
 * independently-tessellated adjacent faces — and closes the small ones with
 * a triangle fan over the boundary's own (already-decoded) vertices. Gaps
 * too large to plausibly be this kind of seam are left as decoded; every
 * outcome (repaired, or left alone and why) is recorded in the returned
 * model's `diagnostics`, never applied silently.
 *
 * A `'lines'` mesh (a DXF drawing, D6) has no concept of a surface gap and
 * is passed through unchanged.
 */
export function repairSmallGaps(
  model: DecodedModel,
  options?: GapRepairOptions,
): DecodedModel {
  const maxRelativeGapSize =
    options?.maxRelativeGapSize ?? DEFAULT_MAX_RELATIVE_GAP_SIZE;
  const modelDiagonal = modelBoundingDiagonal(model);

  let totalFilledGaps = 0;
  let totalFilledTriangles = 0;
  let totalSkippedLargeGaps = 0;
  let totalAmbiguousBoundaryEdges = 0;

  const meshes = model.meshes.map((mesh) => {
    if (mesh.topology === "lines") {
      return mesh;
    }
    const result = repairMesh(mesh, modelDiagonal * maxRelativeGapSize);
    totalFilledGaps += result.filledGapCount;
    totalFilledTriangles += result.filledTriangleCount;
    totalSkippedLargeGaps += result.skippedLargeGapCount;
    totalAmbiguousBoundaryEdges += result.ambiguousBoundaryEdgeCount;
    return result.mesh;
  });

  const diagnostics = [
    ...model.diagnostics,
    ...buildDiagnostics({
      totalFilledGaps,
      totalFilledTriangles,
      totalSkippedLargeGaps,
      totalAmbiguousBoundaryEdges,
    }),
  ];

  return { ...model, meshes, diagnostics };
}

interface RepairSummary {
  readonly totalFilledGaps: number;
  readonly totalFilledTriangles: number;
  readonly totalSkippedLargeGaps: number;
  readonly totalAmbiguousBoundaryEdges: number;
}

function buildDiagnostics(summary: RepairSummary): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (summary.totalFilledGaps > 0) {
    diagnostics.push({
      severity: "info",
      code: "gap-repair-filled",
      message:
        `Filled ${summary.totalFilledGaps} small gap(s) ` +
        `(${summary.totalFilledTriangles} patch triangle(s)), coloured ` +
        "distinctly so the repaired area stays identifiable.",
    });
  }
  if (summary.totalSkippedLargeGaps > 0) {
    diagnostics.push({
      severity: "warning",
      code: "gap-repair-skipped-large-gap",
      message:
        `${summary.totalSkippedLargeGaps} gap(s) were too large, relative ` +
        "to the model's own size, to safely auto-fill; left as decoded.",
    });
  }
  if (summary.totalAmbiguousBoundaryEdges > 0) {
    diagnostics.push({
      severity: "warning",
      code: "gap-repair-skipped-ambiguous-boundary",
      message:
        `${summary.totalAmbiguousBoundaryEdges} boundary edge(s) didn't ` +
        "form a simple loop and were left unrepaired.",
    });
  }
  return diagnostics;
}

function modelBoundingDiagonal(model: DecodedModel): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const mesh of model.meshes) {
    const { positions } = mesh;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i] ?? 0;
      const y = positions[i + 1] ?? 0;
      const z = positions[i + 2] ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  if (!Number.isFinite(minX)) {
    return 0;
  }
  return distance3(minX, minY, minZ, maxX, maxY, maxZ);
}

function distance3(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  return Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2);
}

interface MeshRepairResult {
  readonly mesh: DecodedMesh;
  readonly filledGapCount: number;
  readonly filledTriangleCount: number;
  readonly skippedLargeGapCount: number;
  readonly ambiguousBoundaryEdgeCount: number;
}

function repairMesh(
  mesh: DecodedMesh,
  maxGapDiagonal: number,
): MeshRepairResult {
  const canonical = canonicalizeVertices(mesh.positions);
  const { loops, ambiguousBoundaryEdgeCount } = findBoundaryLoops(
    mesh.indices,
    canonical,
  );

  const patches = loops
    .map((loop) => buildFanPatch(loop, mesh.positions, mesh.normals))
    .filter((patch): patch is FanPatch => patch !== undefined);

  const safePatches = patches.filter(
    (patch) => patch.boundingDiagonal <= maxGapDiagonal,
  );
  const skippedLargeGapCount = patches.length - safePatches.length;

  if (safePatches.length === 0) {
    return {
      mesh,
      filledGapCount: 0,
      filledTriangleCount: 0,
      skippedLargeGapCount,
      ambiguousBoundaryEdgeCount,
    };
  }

  const originalVertexCount = mesh.positions.length / 3;
  const originalTriangleCount = mesh.indices.length / 3;

  const patchPositions = new Float32Array(safePatches.length * 3);
  const patchNormals = new Float32Array(safePatches.length * 3);
  const patchIndices: number[] = [];
  let filledTriangleCount = 0;

  safePatches.forEach((patch, patchIndex) => {
    const centroidVertexIndex = originalVertexCount + patchIndex;
    patchPositions.set(patch.centroidPosition, patchIndex * 3);
    patchNormals.set(patch.centroidNormal, patchIndex * 3);
    for (const [a, b] of patch.edges) {
      // Reversed relative to the boundary's own recorded direction — a
      // consistently-wound mesh's hole boundary traces *clockwise* around
      // the missing region when viewed from the outward-normal side (this
      // was verified by hand against a concrete flat-hole example, not
      // assumed; see DECISIONS.md), so the fan needs (b, a, centroid) to
      // come out with the same outward-facing winding as its neighbors.
      patchIndices.push(b, a, centroidVertexIndex);
      filledTriangleCount++;
    }
  });

  const positions = concatFloat32(mesh.positions, patchPositions);
  const normals = concatFloat32(mesh.normals, patchNormals);
  const indices = concatUint32(mesh.indices, Uint32Array.from(patchIndices));
  const faces = extendFaces(
    mesh.faces,
    originalTriangleCount,
    indices.length / 3,
  );

  return {
    mesh: { ...mesh, positions, normals, indices, faces },
    filledGapCount: safePatches.length,
    filledTriangleCount,
    skippedLargeGapCount,
    ambiguousBoundaryEdgeCount,
  };
}

/**
 * `faces` must exactly and contiguously cover `indices` once it's non-empty
 * (FaceRange.ts) — so giving the patch its own distinct colour means first
 * covering the *original* geometry with one unbroken range (keeping its
 * current appearance, since it carries no colour of its own) rather than
 * leaving it outside every group, which `toThree`'s per-group rendering
 * would silently stop drawing altogether. A mesh that already tracked
 * per-face colour (OCCT) keeps its existing ranges untouched and just gains
 * one more for the patch.
 */
function extendFaces(
  faces: readonly FaceRange[],
  originalTriangleCount: number,
  totalTriangleCount: number,
): FaceRange[] {
  const patchTriangleCount = totalTriangleCount - originalTriangleCount;
  if (patchTriangleCount === 0) {
    return [...faces];
  }
  const nextId = 1 + faces.reduce((max, face) => Math.max(max, face.id), -1);
  const baseFaces =
    faces.length > 0
      ? faces
      : [{ id: nextId, start: 0, count: originalTriangleCount * 3 }];
  const patchId = faces.length > 0 ? nextId : nextId + 1;
  return [
    ...baseFaces,
    {
      id: patchId,
      start: originalTriangleCount * 3,
      count: patchTriangleCount * 3,
      color: PATCH_COLOR,
    },
  ];
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function concatUint32(a: Uint32Array, b: Uint32Array): Uint32Array {
  const result = new Uint32Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function snapKey(positions: Float32Array, vertexIndex: number): string {
  const round = (value: number) => Math.round(value / VERTEX_SNAP_EPSILON_MM);
  const x = positions[vertexIndex * 3] ?? 0;
  const y = positions[vertexIndex * 3 + 1] ?? 0;
  const z = positions[vertexIndex * 3 + 2] ?? 0;
  return `${round(x)},${round(y)},${round(z)}`;
}

/**
 * Maps every vertex index to the first-seen index at its (snapped)
 * position — vertices this project's decoders never merge across separate
 * tessellation blocks, even when two faces' triangles share an edge in
 * space. The returned array doubles as a set of real, valid vertex indices
 * usable directly in a new triangle: canonical(v) always names an actual
 * decoded vertex, never a synthesized one.
 */
function canonicalizeVertices(positions: Float32Array): Uint32Array {
  const vertexCount = positions.length / 3;
  const canonical = new Uint32Array(vertexCount);
  const firstSeenAt = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = snapKey(positions, i);
    const existing = firstSeenAt.get(key);
    if (existing === undefined) {
      firstSeenAt.set(key, i);
      canonical[i] = i;
    } else {
      canonical[i] = existing;
    }
  }
  return canonical;
}

interface BoundaryLoop {
  /** Canonical vertex indices around the loop, each a real, valid index
   * into the mesh's own positions/normals, in the boundary's own induced
   * direction (see the winding-reversal note where fan triangles are
   * built). */
  readonly vertexIds: readonly number[];
}

interface BoundaryScanResult {
  readonly loops: readonly BoundaryLoop[];
  readonly ambiguousBoundaryEdgeCount: number;
}

/**
 * A closed 2-manifold surface uses every edge exactly twice (once from each
 * adjacent triangle, in opposite directions). An edge used exactly once is
 * a genuine boundary. Collects those, discards any vertex where more than
 * one boundary edge meets (a real hole rim never branches — a vertex like
 * that means either a non-manifold defect or two unrelated gaps touching,
 * and guessing which is which risks stitching the wrong things together),
 * and walks what's left into simple closed loops.
 */
function findBoundaryLoops(
  indices: Uint32Array,
  canonical: Uint32Array,
): BoundaryScanResult {
  const edgeTriangleCount = new Map<string, number>();
  const lastDirected = new Map<string, readonly [number, number]>();

  const triangleCount = indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const raw: [number, number, number] = [
      indices[t * 3] ?? 0,
      indices[t * 3 + 1] ?? 0,
      indices[t * 3 + 2] ?? 0,
    ];
    // Falls back to the raw index itself, not 0 (unlike every other
    // fallback in this file) -- an out-of-range vertex index would be a
    // decoder bug the caller should still be able to trace, not a silent
    // remap onto vertex 0's unrelated position.
    const c = raw.map((i) => canonical[i] ?? i);
    for (let e = 0; e < 3; e++) {
      const from = c[e] ?? 0;
      const to = c[(e + 1) % 3] ?? 0;
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      edgeTriangleCount.set(key, (edgeTriangleCount.get(key) ?? 0) + 1);
      lastDirected.set(key, [from, to]);
    }
  }

  const boundaryDirected: [number, number][] = [];
  for (const [key, count] of edgeTriangleCount) {
    if (count !== 1) {
      continue;
    }
    const directed = lastDirected.get(key);
    if (directed !== undefined) {
      boundaryDirected.push([directed[0], directed[1]]);
    }
  }

  const outDegree = new Map<number, number>();
  const inDegree = new Map<number, number>();
  for (const [from, to] of boundaryDirected) {
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  const next = new Map<number, number>();
  let ambiguousBoundaryEdgeCount = 0;
  for (const [from, to] of boundaryDirected) {
    const clean =
      (outDegree.get(from) ?? 0) === 1 &&
      (inDegree.get(from) ?? 0) === 1 &&
      (outDegree.get(to) ?? 0) === 1 &&
      (inDegree.get(to) ?? 0) === 1;
    if (!clean) {
      ambiguousBoundaryEdgeCount++;
      continue;
    }
    next.set(from, to);
  }

  const visited = new Set<number>();
  const loops: BoundaryLoop[] = [];
  for (const start of next.keys()) {
    if (visited.has(start)) {
      continue;
    }
    const sequence: number[] = [];
    let current = start;
    while (!visited.has(current)) {
      visited.add(current);
      sequence.push(current);
      const nextVertex = next.get(current);
      if (nextVertex === undefined) {
        break;
      }
      current = nextVertex;
    }
    if (current === start && sequence.length >= 3) {
      loops.push({ vertexIds: sequence });
    } else {
      ambiguousBoundaryEdgeCount += sequence.length;
    }
  }

  return { loops, ambiguousBoundaryEdgeCount };
}

interface FanPatch {
  readonly centroidPosition: readonly [number, number, number];
  readonly centroidNormal: readonly [number, number, number];
  /** Consecutive boundary-vertex pairs, in the loop's own induced
   * direction — reversed at the point of use (see repairMesh) to come out
   * with the correct outward winding. */
  readonly edges: readonly (readonly [number, number])[];
  readonly boundingDiagonal: number;
}

/**
 * A degenerate loop (its vertices' own decoded normals cancel out, e.g. a
 * perfectly straight sliver) has no reliable "outward" direction to give
 * the patch — returning `undefined` here defers to
 * `ambiguousBoundaryEdgeCount` rather than emitting a triangle with a zero
 * normal.
 */
function buildFanPatch(
  loop: BoundaryLoop,
  positions: Float32Array,
  normals: Float32Array,
): FanPatch | undefined {
  const { vertexIds } = loop;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let sumNx = 0;
  let sumNy = 0;
  let sumNz = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const id of vertexIds) {
    const x = positions[id * 3] ?? 0;
    const y = positions[id * 3 + 1] ?? 0;
    const z = positions[id * 3 + 2] ?? 0;
    sumX += x;
    sumY += y;
    sumZ += z;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    sumNx += normals[id * 3] ?? 0;
    sumNy += normals[id * 3 + 1] ?? 0;
    sumNz += normals[id * 3 + 2] ?? 0;
  }

  const normalLength = Math.sqrt(sumNx ** 2 + sumNy ** 2 + sumNz ** 2);
  if (normalLength < 1e-9) {
    return undefined;
  }

  const n = vertexIds.length;
  const edges: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = vertexIds[k];
    const b = vertexIds[(k + 1) % n];
    if (a === undefined || b === undefined) {
      continue;
    }
    edges.push([a, b]);
  }

  return {
    centroidPosition: [sumX / n, sumY / n, sumZ / n],
    centroidNormal: [
      sumNx / normalLength,
      sumNy / normalLength,
      sumNz / normalLength,
    ],
    edges,
    boundingDiagonal: distance3(minX, minY, minZ, maxX, maxY, maxZ),
  };
}
