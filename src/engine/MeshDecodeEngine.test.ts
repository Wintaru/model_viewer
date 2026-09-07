import { describe, expect, it } from "vitest";
import { MeshDecodeEngine } from "./MeshDecodeEngine.js";

interface Triangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

function binaryStl(triangles: readonly Triangle[]): Uint8Array {
  const HEADER_SIZE = 80;
  const bytes = new Uint8Array(HEADER_SIZE + 4 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(HEADER_SIZE, triangles.length, true);

  let offset = HEADER_SIZE + 4;
  for (const triangle of triangles) {
    for (const component of triangle.normal) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
    for (const vertex of triangle.vertices) {
      for (const component of vertex) {
        view.setFloat32(offset, component, true);
        offset += 4;
      }
    }
    offset += 2; // attribute byte count
  }
  return bytes;
}

const oneTriangle: Triangle = {
  normal: [0, 0, 1],
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
};

describe("MeshDecodeEngine", () => {
  const decode = new MeshDecodeEngine();

  it("decodes a single triangle", () => {
    const model = decode.transform(binaryStl([oneTriangle]));

    expect(model.meshes).toHaveLength(1);
    const [mesh] = model.meshes;
    expect(mesh?.positions).toEqual(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    );
    expect(mesh?.normals).toEqual(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    );
    expect(mesh?.indices).toEqual(new Uint32Array([0, 1, 2]));
  });

  it("decodes multiple triangles into one contiguous mesh", () => {
    const model = decode.transform(binaryStl([oneTriangle, oneTriangle]));

    const [mesh] = model.meshes;
    expect(mesh?.positions).toHaveLength(18);
    expect(mesh?.indices).toEqual(new Uint32Array([0, 1, 2, 3, 4, 5]));
  });

  it("reports mm units with a warning, since STL carries no unit information", () => {
    const model = decode.transform(binaryStl([oneTriangle]));

    expect(model.units).toBe("mm");
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "units-assumed-mm",
      }),
    );
  });

  it("reports no face identity, since binary STL has none", () => {
    const model = decode.transform(binaryStl([oneTriangle]));

    expect(model.meshes[0]?.faces).toEqual([]);
  });

  it("builds a single-node tree pointing at the one mesh", () => {
    const model = decode.transform(binaryStl([oneTriangle]));

    expect(model.tree).toEqual([{ meshIndices: [0], children: [] }]);
  });

  it("decodes zero triangles as an empty mesh, not a decode failure", () => {
    const model = decode.transform(binaryStl([]));

    expect(model.meshes).toHaveLength(1);
    expect(model.meshes[0]?.positions).toHaveLength(0);
    expect(model.diagnostics.some((d) => d.severity === "error")).toBe(false);
  });

  it("reports an error, with no meshes, for ASCII STL", () => {
    const bytes = Uint8Array.from("solid part\nendsolid part\n", (c) =>
      c.charCodeAt(0),
    );

    const model = decode.transform(bytes);

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "ascii-stl-unsupported",
      }),
    );
  });

  it("reports an error, with no meshes, for bytes that are not STL at all", () => {
    const bytes = Uint8Array.from("this is not a CAD file", (c) =>
      c.charCodeAt(0),
    );

    const model = decode.transform(bytes);

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "invalid-stl" }),
    );
  });

  it("reports an error for a truncated binary STL (declared count exceeds available bytes)", () => {
    const wholeFile = binaryStl([oneTriangle, oneTriangle]);
    const truncated = wholeFile.subarray(0, wholeFile.byteLength - 10);

    const model = decode.transform(truncated);

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error" }),
    );
  });
});
