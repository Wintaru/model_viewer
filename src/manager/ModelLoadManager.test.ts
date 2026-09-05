import { describe, expect, it } from "vitest";
import { fromBuffer } from "../accessor/BufferSourceAccessor";
import { ModelLoadManager } from "./ModelLoadManager";

interface Triangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

// TypeScript's typed arrays are generic over their backing buffer as of
// TS 5.7+. An unparameterized `Uint8Array` return annotation widens to the
// loose `Uint8Array<ArrayBufferLike>` default, which File/Blob's
// BlobPart type (and a plain `ArrayBuffer` slot) then reject — the
// annotation below keeps the more specific type `new Uint8Array(n)`
// actually has.
function binaryStl(triangles: readonly Triangle[]): Uint8Array<ArrayBuffer> {
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
    offset += 2;
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

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe("ModelLoadManager", () => {
  it("loads a binary STL given raw bytes (Uint8Array)", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(binaryStl([oneTriangle]));

    expect(model.meshes).toHaveLength(1);
    expect(model.meshes[0]?.positions).toHaveLength(9);
  });

  it("loads a binary STL given an ArrayBuffer", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(binaryStl([oneTriangle]).buffer);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given a File", async () => {
    const manager = new ModelLoadManager();
    const file = new File([binaryStl([oneTriangle])], "part.stl");

    const model = await manager.load(file);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given a plain Blob", async () => {
    const manager = new ModelLoadManager();
    const blob = new Blob([binaryStl([oneTriangle])]);

    const model = await manager.load(blob);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given an already-built ModelSource", async () => {
    const manager = new ModelLoadManager();
    const source = fromBuffer(binaryStl([oneTriangle]), "part.stl");

    const model = await manager.load(source);

    expect(model.meshes).toHaveLength(1);
  });

  it("reports unsupported-format for a recognized-but-undecodable format", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(ascii("ISO-10303-21;\nHEADER;\n"));

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unsupported-format",
      }),
    );
    expect(model.diagnostics[0]?.message).toContain("step");
  });

  it("reports unrecognized-format for bytes matching no known format", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(ascii("this is not a CAD file"));

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unrecognized-format",
      }),
    );
  });

  it("accepts injected engines, for testing without the real ones", async () => {
    const fakeSniffer = { transform: () => "stl" as const };
    const fakeDecoder = {
      transform: () => ({
        units: "mm" as const,
        meshes: [],
        tree: [],
        metadata: { source: "fake" },
        diagnostics: [],
      }),
    };
    const manager = new ModelLoadManager(fakeSniffer, fakeDecoder);

    const model = await manager.load(new Uint8Array(0));

    expect(model.metadata).toEqual({ source: "fake" });
  });
});
