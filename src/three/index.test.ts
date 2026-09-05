import { describe, expect, it } from "vitest";
import { Matrix4, Mesh, MeshStandardMaterial, type Object3D } from "three";
import { toThree } from "./index";
import type { DecodedMesh, DecodedModel, SceneNode } from "../common";

function unitTriangleMesh(overrides: Partial<DecodedMesh> = {}): DecodedMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    faces: [],
    ...overrides,
  };
}

function modelWith(
  meshes: readonly DecodedMesh[],
  tree: readonly SceneNode[],
): DecodedModel {
  return { units: "mm", meshes, tree, metadata: {}, diagnostics: [] };
}

/**
 * Fails the test with a clear message if the shape is wrong. The trailing
 * `as Mesh` is a known three.js typings gap, not an unchecked assertion: the
 * `instanceof` guard above it already proved the value is a `Mesh` at
 * runtime, but `Mesh` is generic over its geometry/material/event-map type
 * parameters, and `instanceof` narrows a generic class to
 * `Mesh<any, any, any>` rather than to its declared defaults — that `any`
 * is what `@typescript-eslint/no-unsafe-return` is (correctly, in general)
 * objecting to.
 */
function meshChildAt(object: Object3D, index: number): Mesh {
  const child = object.children[index];
  if (!(child instanceof Mesh)) {
    throw new Error(
      `Expected a Mesh at children[${index}], got ${child?.type ?? "nothing"}`,
    );
  }
  return child as Mesh;
}

describe("toThree", () => {
  it("builds one Mesh per DecodedMesh, wired through the scene tree", () => {
    const mesh = unitTriangleMesh();
    const model = modelWith([mesh], [{ meshIndices: [0], children: [] }]);

    const root = toThree(model);

    expect(root.children).toHaveLength(1);
    const [node] = root.children;
    expect(node?.children).toHaveLength(1);
    const meshObject = meshChildAt(node ?? root, 0);
    expect(meshObject.geometry.getAttribute("position").array).toEqual(
      mesh.positions,
    );
    expect(meshObject.geometry.getAttribute("normal").array).toEqual(
      mesh.normals,
    );
    expect(meshObject.geometry.getIndex()?.array).toEqual(mesh.indices);
  });

  it("recurses into children, preserving the assembly structure", () => {
    const model = modelWith(
      [unitTriangleMesh()],
      [{ meshIndices: [], children: [{ meshIndices: [0], children: [] }] }],
    );

    const root = toThree(model);

    expect(root.children).toHaveLength(1);
    const [group] = root.children;
    expect(group?.children).toHaveLength(1);
  });

  it("wraps every root SceneNode under one returned Group", () => {
    const model = modelWith(
      [unitTriangleMesh()],
      [
        { meshIndices: [0], children: [] },
        { meshIndices: [0], children: [] },
      ],
    );

    const root = toThree(model);

    expect(root.children).toHaveLength(2);
  });

  it("clones the three.js Mesh per scene-graph reference, but shares geometry across instances", () => {
    const model = modelWith(
      [unitTriangleMesh()],
      [
        { meshIndices: [0], children: [] },
        { meshIndices: [0], children: [] },
      ],
    );

    const root = toThree(model);

    const [a, b] = root.children;
    const meshA = meshChildAt(a ?? root, 0);
    const meshB = meshChildAt(b ?? root, 0);
    expect(meshA).not.toBe(meshB);
    expect(meshA.geometry).toBe(meshB.geometry);
  });

  it("applies a SceneNode's column-major transform directly to the node's matrix", () => {
    // A matrix with shear (not a pure translate/rotate/scale) — chosen
    // deliberately so a `decompose()`-based implementation, which silently
    // discards shear, would fail this test instead of passing it by luck.
    const sheared = new Matrix4()
      .makeTranslation(10, 20, 30)
      .multiply(
        new Matrix4().set(1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
      );
    const transform = new Float32Array(sheared.toArray());
    const model = modelWith(
      [unitTriangleMesh()],
      [{ meshIndices: [0], children: [], transform }],
    );

    const root = toThree(model);

    const node = root.children[0];
    expect(node?.matrixAutoUpdate).toBe(false);
    expect(node?.matrix.toArray()).toEqual(Array.from(transform));
  });

  it("leaves a node's matrix auto-updating from the (identity) default when no transform is given", () => {
    const model = modelWith(
      [unitTriangleMesh()],
      [{ meshIndices: [0], children: [] }],
    );

    const root = toThree(model);

    const node = root.children[0];
    expect(node?.matrixAutoUpdate).toBe(true);
    expect(node?.matrix.equals(new Matrix4())).toBe(true);
  });

  it("defaults to a plain grey material when no colour is given", () => {
    const model = modelWith(
      [unitTriangleMesh()],
      [{ meshIndices: [0], children: [] }],
    );

    const root = toThree(model);

    const meshObject = meshChildAt(root.children[0] ?? root, 0);
    const material = meshObject.material as MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0x9a9a9a);
  });

  it("uses the mesh's own colour when one is given", () => {
    const mesh = unitTriangleMesh({ color: [1, 0, 0] });
    const model = modelWith([mesh], [{ meshIndices: [0], children: [] }]);

    const root = toThree(model);

    const meshObject = meshChildAt(root.children[0] ?? root, 0);
    const material = meshObject.material as MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0xff0000);
  });

  it("treats colour as sRGB, not three.js's linear working space", () => {
    // A pure primary (0 or 1 per channel) is a fixed point of the sRGB<->
    // linear conversion, so it can't catch a missing colour-space
    // conversion — only a mid-range value can. Un-converted linear 0.5
    // round-trips to 0xbcbcbc, not 0x808080; see DECISIONS.md.
    const mesh = unitTriangleMesh({ color: [0.5, 0.5, 0.5] });
    const model = modelWith([mesh], [{ meshIndices: [0], children: [] }]);

    const root = toThree(model);

    const meshObject = meshChildAt(root.children[0] ?? root, 0);
    const material = meshObject.material as MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0x808080);
  });

  it("preserves CAD face identity as three.js geometry groups", () => {
    const mesh = unitTriangleMesh({
      faces: [{ id: 7, start: 0, count: 3 }],
    });
    const model = modelWith([mesh], [{ meshIndices: [0], children: [] }]);

    const root = toThree(model);

    const meshObject = meshChildAt(root.children[0] ?? root, 0);
    expect(meshObject.geometry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
    ]);
    expect(meshObject.geometry.userData.faceIds).toEqual([7]);
    expect(Array.isArray(meshObject.material)).toBe(true);
  });

  it("throws when a SceneNode references a mesh index the model doesn't have", () => {
    const model = modelWith([], [{ meshIndices: [0], children: [] }]);

    expect(() => toThree(model)).toThrow(RangeError);
  });
});
