import { describe, expect, it } from "vitest";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import type { DecodedMesh } from "../common/DecodedMesh";
import type { SceneNode } from "../common/SceneNode";
import { GltfEncodeEngine } from "./GltfEncodeEngine";

interface GltfAccessorJson {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfNodeJson {
  name?: string;
  children?: number[];
  matrix?: number[];
  mesh?: number;
}

interface GltfDocumentJson {
  asset: { version: string };
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: GltfNodeJson[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      indices: number;
      mode: number;
    }[];
  }[];
  accessors?: GltfAccessorJson[];
  bufferViews?: {
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target?: number;
  }[];
  buffers?: { uri: string; byteLength: number }[];
}

function triangleMesh(originX: number): DecodedMesh {
  return {
    positions: new Float32Array([
      originX,
      0,
      0,
      originX + 1,
      0,
      0,
      originX,
      1,
      0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    faces: [{ id: 0, start: 0, count: 3 }],
  };
}

function bytesOf(view: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function decodeDataUri(uri: string): Uint8Array<ArrayBuffer> {
  const prefix = "data:application/octet-stream;base64,";
  expect(uri.startsWith(prefix)).toBe(true);
  const binary = atob(uri.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseDocument(bytes: Uint8Array): GltfDocumentJson {
  return JSON.parse(new TextDecoder().decode(bytes)) as GltfDocumentJson;
}

describe("GltfEncodeEngine", () => {
  it("emits a minimal, valid document for a model with no meshes or tree", () => {
    const engine = new GltfEncodeEngine();
    const model = createEmptyDecodedModel({
      severity: "error",
      code: "unsupported-format",
      message: "nothing to export",
    });

    const document = parseDocument(engine.transform(model));

    expect(document).toEqual({ asset: { version: "2.0" } });
  });

  it("encodes geometry and a translated node tree, round-tripping the exact bytes", () => {
    const mesh0 = triangleMesh(0);
    const mesh1 = triangleMesh(2);
    // Column-major 4x4, identity rotation, translated by (5, 6, 7) —
    // SceneNode.transform's own documented layout, which is also exactly
    // glTF's `matrix` layout.
    const translation = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1,
    ]);
    const child: SceneNode = {
      name: "child",
      transform: translation,
      meshIndices: [1],
      children: [],
    };
    const root: SceneNode = {
      name: "root",
      meshIndices: [0],
      children: [child],
    };
    const model: DecodedModel = {
      units: "mm",
      meshes: [mesh0, mesh1],
      tree: [root],
      metadata: {},
      diagnostics: [],
    };

    const engine = new GltfEncodeEngine();
    const document = parseDocument(engine.transform(model));

    // -- top-level shape --
    expect(document.asset.version).toBe("2.0");
    expect(document.scene).toBe(0);
    expect(document.scenes).toEqual([{ nodes: [1] }]);
    expect(document.nodes).toHaveLength(2);
    expect(document.meshes).toHaveLength(2);
    expect(document.accessors).toHaveLength(6);

    const nodes = document.nodes ?? [];
    const childNode = nodes[0];
    const rootNode = nodes[1];
    if (childNode === undefined || rootNode === undefined) {
      throw new Error("expected both nodes to exist");
    }

    // -- node tree, built child-first by recursion --
    expect(childNode.name).toBe("child");
    expect(childNode.matrix).toEqual(Array.from(translation));
    expect(childNode.children).toBeUndefined();
    expect(rootNode.name).toBe("root");
    expect(rootNode.matrix).toBeUndefined();
    expect(rootNode.children).toEqual([0]);

    // -- each node's mesh has exactly one primitive, one triangle --
    const meshes = document.meshes ?? [];
    const childMesh = meshes[childNode.mesh ?? -1];
    const rootMesh = meshes[rootNode.mesh ?? -1];
    if (childMesh === undefined || rootMesh === undefined) {
      throw new Error("expected both nodes to reference a mesh");
    }
    expect(childMesh.primitives).toHaveLength(1);
    expect(rootMesh.primitives).toHaveLength(1);
    const childIndicesAccessor =
      document.accessors?.[childMesh.primitives[0]?.indices ?? -1];
    const rootIndicesAccessor =
      document.accessors?.[rootMesh.primitives[0]?.indices ?? -1];
    expect(childIndicesAccessor?.count).toBe(3);
    expect(rootIndicesAccessor?.count).toBe(3);

    // -- position accessor bounds, per mesh --
    const rootPositionAccessor =
      document.accessors?.[rootMesh.primitives[0]?.attributes.POSITION ?? -1];
    const childPositionAccessor =
      document.accessors?.[childMesh.primitives[0]?.attributes.POSITION ?? -1];
    expect(rootPositionAccessor?.min).toEqual([0, 0, 0]);
    expect(rootPositionAccessor?.max).toEqual([1, 1, 0]);
    expect(childPositionAccessor?.min).toEqual([2, 0, 0]);
    expect(childPositionAccessor?.max).toEqual([3, 1, 0]);

    // -- normal accessors carry no bounds --
    const rootNormalAccessor =
      document.accessors?.[rootMesh.primitives[0]?.attributes.NORMAL ?? -1];
    expect(rootNormalAccessor?.min).toBeUndefined();
    expect(rootNormalAccessor?.max).toBeUndefined();

    // -- byte-for-byte round trip through the base64 buffer --
    const buffer = document.buffers?.[0];
    expect(buffer).toBeDefined();
    const decoded = decodeDataUri(buffer?.uri ?? "");
    expect(decoded.byteLength).toBe(buffer?.byteLength);

    const expectedChunks = [
      bytesOf(mesh0.positions),
      bytesOf(mesh0.normals),
      bytesOf(mesh0.indices),
      bytesOf(mesh1.positions),
      bytesOf(mesh1.normals),
      bytesOf(mesh1.indices),
    ];
    let offset = 0;
    for (const chunk of expectedChunks) {
      expect(decoded.subarray(offset, offset + chunk.byteLength)).toEqual(
        chunk,
      );
      offset += chunk.byteLength;
    }
    expect(offset).toBe(decoded.byteLength);

    // -- bufferViews line up with the same concatenation order --
    const bufferViews = document.bufferViews ?? [];
    expect(bufferViews).toHaveLength(6);
    let expectedOffset = 0;
    for (const [i, chunk] of expectedChunks.entries()) {
      const view = bufferViews[i];
      expect(view?.byteOffset).toBe(expectedOffset);
      expect(view?.byteLength).toBe(chunk.byteLength);
      expectedOffset += chunk.byteLength;
    }
  });

  it("skips an empty mesh without emitting a zero-count accessor, and omits `mesh` on a node left with nothing to draw", () => {
    const emptyMesh: DecodedMesh = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      faces: [],
    };
    const realMesh = triangleMesh(0);
    const emptyNode: SceneNode = { meshIndices: [0], children: [] };
    const realNode: SceneNode = { meshIndices: [1], children: [] };
    const model: DecodedModel = {
      units: "mm",
      meshes: [emptyMesh, realMesh],
      tree: [emptyNode, realNode],
      metadata: {},
      diagnostics: [],
    };

    const document = parseDocument(new GltfEncodeEngine().transform(model));

    // Only the real mesh's three accessors (position, normal, indices) —
    // none for the empty one.
    expect(document.accessors).toHaveLength(3);
    expect(document.meshes).toHaveLength(1);
    const nodes = document.nodes ?? [];
    expect(nodes[0]?.mesh).toBeUndefined();
    expect(nodes[1]?.mesh).toBe(0);
  });

  it("throws when a SceneNode references a mesh index outside the model's meshes array", () => {
    const model: DecodedModel = {
      units: "mm",
      meshes: [triangleMesh(0)],
      tree: [{ meshIndices: [5], children: [] }],
      metadata: {},
      diagnostics: [],
    };

    expect(() => new GltfEncodeEngine().transform(model)).toThrow(
      /mesh index 5/,
    );
  });
});
