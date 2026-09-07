import type { DecodedMesh } from "../common/DecodedMesh.js";
import type { DecodedModel } from "../common/DecodedModel.js";
import type { SceneNode } from "../common/SceneNode.js";

const GLTF_VERSION = "2.0";

// glTF 2.0's numeric enums (its own spec, not this project's invention).
const COMPONENT_TYPE_FLOAT = 5126;
const COMPONENT_TYPE_UNSIGNED_INT = 5125;
const PRIMITIVE_MODE_TRIANGLES = 4;
const BUFFER_VIEW_TARGET_ARRAY_BUFFER = 34962;
const BUFFER_VIEW_TARGET_ELEMENT_ARRAY_BUFFER = 34963;

const VEC3_COMPONENT_COUNT = 3;
const GLTF_DATA_URI_PREFIX = "data:application/octet-stream;base64,";
// String.fromCharCode(...bytes) blows the call stack on a large typed
// array (V8's argument-list limit is well under a multi-megabyte mesh's
// byte count) — converting in fixed-size chunks avoids that without
// needing a streaming base64 encoder.
const BASE64_CHUNK_SIZE = 0x8000;

interface GltfAccessor {
  readonly bufferView: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: "VEC3" | "SCALAR";
  readonly min?: readonly [number, number, number];
  readonly max?: readonly [number, number, number];
}

interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly target?: number;
}

interface GltfPrimitive {
  readonly attributes: { readonly POSITION: number; readonly NORMAL: number };
  readonly indices: number;
  readonly mode: number;
}

interface GltfMesh {
  readonly primitives: readonly GltfPrimitive[];
}

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  mesh?: number;
}

interface GltfDocument {
  readonly asset: { readonly version: string };
  scene?: number;
  scenes?: { readonly nodes: readonly number[] }[];
  nodes?: readonly GltfNode[];
  meshes?: readonly GltfMesh[];
  accessors?: readonly GltfAccessor[];
  bufferViews?: readonly GltfBufferView[];
  buffers?: { readonly uri: string; readonly byteLength: number }[];
}

/**
 * A decoded model to glTF bytes (SPEC.md section 3). Pure and synchronous,
 * like `FormatSniffEngine` — no I/O of its own.
 *
 * Emits a single-file, embedded glTF 2.0 document: one `buffer` holding
 * every mesh's positions, normals and indices back to back, referenced by
 * a base64 `data:` URI, rather than a packed binary `.glb`. Simpler to
 * build and to verify byte-for-byte in a test, at the cost of a larger
 * export than a packed binary would produce — see DECISIONS.md's slice 5
 * planning entry for why that trade was accepted for v1.
 *
 * **Scope: geometry and the node tree only.** No materials, vertex colors,
 * metadata or embedded preview — `DecodedMesh.color`, `FaceRange.color` and
 * `DecodedModel.metadata`/`preview` go unexported for now, the same
 * "mixing two concerns" call slice 1 made for OBJ/PLY/glTF/3MF import.
 * Logged in REVIEW-BACKLOG.md.
 */
export class GltfEncodeEngine {
  transform(model: DecodedModel): Uint8Array {
    const builder = new BinaryBufferBuilder();
    const accessors: GltfAccessor[] = [];
    const meshPrimitives = model.meshes.map((mesh) =>
      buildPrimitive(mesh, builder, accessors),
    );

    const nodes: GltfNode[] = [];
    const meshes: GltfMesh[] = [];
    const rootIndices = model.tree.map((root) =>
      buildNode(root, meshPrimitives, nodes, meshes),
    );

    const { bytes, bufferViews } = builder.build();

    const document: GltfDocument = { asset: { version: GLTF_VERSION } };
    if (rootIndices.length > 0) {
      document.scene = 0;
      document.scenes = [{ nodes: rootIndices }];
    }
    if (nodes.length > 0) {
      document.nodes = nodes;
    }
    if (meshes.length > 0) {
      document.meshes = meshes;
    }
    if (accessors.length > 0) {
      document.accessors = accessors;
    }
    if (bufferViews.length > 0) {
      document.bufferViews = bufferViews;
    }
    if (bytes.byteLength > 0) {
      document.buffers = [
        { uri: toDataUri(bytes), byteLength: bytes.byteLength },
      ];
    }

    return new TextEncoder().encode(JSON.stringify(document));
  }
}

/**
 * Accumulates every mesh's raw bytes into one combined buffer, handing back
 * a `bufferViews` entry (with its own offset into that buffer) per chunk
 * added. Every chunk here is `Float32Array` or `Uint32Array` data, so every
 * `byteLength` is already a multiple of 4 — glTF's alignment requirement
 * for these component types holds automatically, with no padding logic
 * needed between chunks.
 */
class BinaryBufferBuilder {
  private readonly chunks: Uint8Array[] = [];
  private readonly views: GltfBufferView[] = [];
  private byteOffset = 0;

  addBufferView(bytes: Uint8Array, target: number): number {
    this.views.push({
      buffer: 0,
      byteOffset: this.byteOffset,
      byteLength: bytes.byteLength,
      target,
    });
    this.chunks.push(bytes);
    this.byteOffset += bytes.byteLength;
    return this.views.length - 1;
  }

  build(): { bytes: Uint8Array; bufferViews: readonly GltfBufferView[] } {
    const combined = new Uint8Array(this.byteOffset);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: combined, bufferViews: this.views };
  }
}

/**
 * `undefined` when `mesh` has no triangles — a real, reachable case
 * (`OcctDecodeEngine`'s own "success but zero meshes" diagnostic shows a
 * decoder can produce one). glTF 2.0's JSON schema requires
 * `accessor.count >= 1` and `bufferView.byteLength >= 1`, so emitting a
 * zero-count accessor for an empty mesh would be schema-invalid — skipping
 * it here means no accessor or bufferView is ever created for it at all,
 * rather than one that violates those minimums.
 */
function buildPrimitive(
  mesh: DecodedMesh,
  builder: BinaryBufferBuilder,
  accessors: GltfAccessor[],
): GltfPrimitive | undefined {
  if (mesh.indices.length === 0) {
    return undefined;
  }
  const position = pushVec3FloatAccessor(mesh.positions, builder, accessors, {
    withBounds: true,
  });
  const normal = pushVec3FloatAccessor(mesh.normals, builder, accessors, {
    withBounds: false,
  });
  const indices = pushIndicesAccessor(mesh.indices, builder, accessors);
  return {
    attributes: { POSITION: position, NORMAL: normal },
    indices,
    mode: PRIMITIVE_MODE_TRIANGLES,
  };
}

function pushVec3FloatAccessor(
  values: Float32Array,
  builder: BinaryBufferBuilder,
  accessors: GltfAccessor[],
  options: { withBounds: boolean },
): number {
  const bufferView = builder.addBufferView(
    bytesOf(values),
    BUFFER_VIEW_TARGET_ARRAY_BUFFER,
  );
  const accessor: GltfAccessor = {
    bufferView,
    componentType: COMPONENT_TYPE_FLOAT,
    count: values.length / VEC3_COMPONENT_COUNT,
    type: "VEC3",
  };
  // glTF 2.0 requires min/max on the accessor a primitive uses as POSITION;
  // it's optional (and skipped here) for every other accessor.
  if (options.withBounds) {
    const bounds = computeVec3Bounds(values);
    accessors.push({ ...accessor, min: bounds.min, max: bounds.max });
  } else {
    accessors.push(accessor);
  }
  return accessors.length - 1;
}

function pushIndicesAccessor(
  indices: Uint32Array,
  builder: BinaryBufferBuilder,
  accessors: GltfAccessor[],
): number {
  const bufferView = builder.addBufferView(
    bytesOf(indices),
    BUFFER_VIEW_TARGET_ELEMENT_ARRAY_BUFFER,
  );
  accessors.push({
    bufferView,
    componentType: COMPONENT_TYPE_UNSIGNED_INT,
    count: indices.length,
    type: "SCALAR",
  });
  return accessors.length - 1;
}

/**
 * One glTF node per `SceneNode`, recursively. A node with one or more
 * `meshIndices` gets its own new `meshes[]` entry combining each
 * referenced mesh's already-built primitive — not shared or deduplicated
 * across nodes that happen to reference the same set, which would only
 * save a little JSON, not any geometry (the accessors and buffer bytes
 * underneath are already shared by index).
 *
 * `meshPrimitives[i]` is `undefined` for two different reasons that must
 * not be treated the same way. Within range, `undefined` means
 * `buildPrimitive` legitimately skipped an empty mesh (see its own doc
 * comment) — silently contributing nothing is correct there. An index
 * genuinely out of range means `sceneNode.meshIndices` disagrees with
 * `model.meshes`, which the `SceneNode.meshIndices` contract
 * (`src/common/SceneNode.ts`) says can't happen — trusting that
 * invariant and throwing, rather than filtering it out with the same code
 * as the empty-mesh case, keeps a real decoder bug loud instead of
 * quietly shrinking toward (or reaching) an empty, schema-invalid
 * `mesh.primitives` array.
 */
function buildNode(
  sceneNode: SceneNode,
  meshPrimitives: readonly (GltfPrimitive | undefined)[],
  nodes: GltfNode[],
  meshes: GltfMesh[],
): number {
  const childIndices = sceneNode.children.map((child) =>
    buildNode(child, meshPrimitives, nodes, meshes),
  );

  const node: GltfNode = {};
  if (sceneNode.name !== undefined) {
    node.name = sceneNode.name;
  }
  if (childIndices.length > 0) {
    node.children = childIndices;
  }
  if (sceneNode.transform !== undefined) {
    // SceneNode.transform is already 4x4 column-major in the model's own
    // units (its own doc comment) — exactly glTF's `matrix` layout, so no
    // conversion is needed beyond spreading the typed array into a plain
    // number[] for JSON.
    node.matrix = Array.from(sceneNode.transform);
  }
  const primitives: GltfPrimitive[] = [];
  for (const index of sceneNode.meshIndices) {
    if (index < 0 || index >= meshPrimitives.length) {
      throw new Error(
        `SceneNode references mesh index ${index}, but this model has ${meshPrimitives.length} mesh(es).`,
      );
    }
    const primitive = meshPrimitives[index];
    if (primitive !== undefined) {
      primitives.push(primitive);
    }
  }
  // Every referenced mesh may have been empty (skipped by buildPrimitive),
  // leaving nothing to draw — omit `mesh` entirely rather than push a
  // `mesh.primitives: []` entry, which glTF's schema also forbids.
  if (primitives.length > 0) {
    meshes.push({ primitives });
    node.mesh = meshes.length - 1;
  }

  nodes.push(node);
  return nodes.length - 1;
}

function computeVec3Bounds(values: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  if (values.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += VEC3_COMPONENT_COUNT) {
    const x = values[i];
    const y = values[i + 1];
    const z = values[i + 2];
    if (x === undefined || y === undefined || z === undefined) {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// Reads a typed array's raw memory as bytes, respecting its own byteOffset
// and byteLength rather than assuming it owns its whole backing buffer.
// Assumes a little-endian host — true of every JS engine that exists in
// practice, and what glTF's own binary layout requires anyway.
function bytesOf(view: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function toDataUri(bytes: Uint8Array): string {
  return GLTF_DATA_URI_PREFIX + toBase64(bytes);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}
