import { describe, expect, it } from "vitest";
import { DxfDecodeEngine } from "./DxfDecodeEngine";

const encoder = new TextEncoder();

/**
 * Renders group-code/value pairs as the same flat "code, then value, one
 * per line" text a real DXF file uses, just expressed as tuples instead of
 * raw interleaved strings, so a fixture reads as the group codes it
 * actually contains.
 */
function pairsToText(
  pairs: readonly (readonly [number, string | number])[],
): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join("\n");
}

function dxf(
  ...pairs: readonly (readonly [number, string | number])[]
): Uint8Array {
  return encoder.encode(pairsToText(pairs));
}

const ENTITIES_HEADER = [
  [0, "SECTION"],
  [2, "ENTITIES"],
] as const;
const END_OF_FILE = [
  [0, "ENDSEC"],
  [0, "EOF"],
] as const;

function insunitsHeader(value: number) {
  return [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$INSUNITS"],
    [70, value],
    [0, "ENDSEC"],
  ] as const;
}

describe("DxfDecodeEngine", () => {
  it("decodes a LINE into one 'lines' mesh named after its layer", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [8, "Layer1"],
        [10, 0],
        [20, 0],
        [11, 10],
        [21, 5],
        ...END_OF_FILE,
      ),
    );

    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0];
    expect(mesh?.name).toBe("Layer1");
    expect(mesh?.topology).toBe("lines");
    expect(Array.from(mesh?.positions ?? [])).toEqual([0, 0, 0, 10, 5, 0]);
    expect(Array.from(mesh?.indices ?? [])).toEqual([0, 1]);
    expect(mesh?.normals).toHaveLength(6);
  });

  it("decodes a CIRCLE, tessellated and closing through floating-point coincidence", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...insunitsHeader(4),
        ...ENTITIES_HEADER,
        [0, "CIRCLE"],
        [8, "0"],
        [10, 5],
        [20, 5],
        [40, 2],
        ...END_OF_FILE,
      ),
    );

    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0];
    // 64 segments -> 65 points, 64 line-segment index pairs.
    expect(mesh?.positions).toHaveLength(65 * 3);
    expect(mesh?.indices).toHaveLength(64 * 2);
    expect(mesh?.positions?.[0]).toBeCloseTo(7, 4); // center (5,5) + radius 2, angle 0
    expect(mesh?.positions?.[1]).toBeCloseTo(5, 4);
    // $INSUNITS 4 (mm) is recognized, so no units-assumed diagnostic.
    expect(model.diagnostics.some((d) => d.code === "units-assumed-mm")).toBe(
      false,
    );
  });

  it("decodes an ARC with a segment count scaled to its sweep", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "ARC"],
        [8, "Dim"],
        [10, 0],
        [20, 0],
        [40, 1],
        [50, 0],
        [51, 90],
        ...END_OF_FILE,
      ),
    );

    const mesh = model.meshes[0];
    // A quarter turn gets a quarter of CIRCLE_SEGMENTS (64/4 = 16).
    expect(mesh?.positions).toHaveLength(17 * 3);
    expect(mesh?.positions?.[0]).toBeCloseTo(1, 4); // start: angle 0
    expect(mesh?.positions?.[1]).toBeCloseTo(0, 4);
    const lastIndex = (mesh?.positions?.length ?? 0) - 3;
    expect(mesh?.positions?.[lastIndex]).toBeCloseTo(0, 4); // end: angle pi/2
    expect(mesh?.positions?.[lastIndex + 1]).toBeCloseTo(1, 4);
  });

  it("sweeps an ARC forward through a start/end that wraps past 360 degrees", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "ARC"],
        [8, "0"],
        [10, 0],
        [20, 0],
        [40, 1],
        [50, 350],
        [51, 10],
        ...END_OF_FILE,
      ),
    );

    const mesh = model.meshes[0];
    // A 20 deg sweep gets round(64 * 20 / 360) = 4 segments -> 5 points.
    expect(mesh?.positions).toHaveLength(5 * 3);
    // Starts below the x-axis (350 deg) and ends above it (370 deg = 10
    // deg) — confirms the sweep advanced forward through the wrap.
    expect(mesh?.positions?.[1]).toBeLessThan(0);
    const lastIndex = (mesh?.positions?.length ?? 0) - 3;
    expect(mesh?.positions?.[lastIndex + 1]).toBeGreaterThan(0);
  });

  it("decodes a closed LWPOLYLINE as a triangle with a closing segment", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LWPOLYLINE"],
        [8, "Outline"],
        [90, 3],
        [70, 1], // closed
        [10, 0],
        [20, 0],
        [10, 4],
        [20, 0],
        [10, 0],
        [20, 3],
        ...END_OF_FILE,
      ),
    );

    const mesh = model.meshes[0];
    expect(mesh?.name).toBe("Outline");
    expect(Array.from(mesh?.positions ?? [])).toEqual([
      0, 0, 0, 4, 0, 0, 0, 3, 0,
    ]);
    // Closed: 3 vertices -> 3 segments, including the closing one back to 0.
    expect(Array.from(mesh?.indices ?? [])).toEqual([0, 1, 1, 2, 2, 0]);
  });

  it("leaves an open LWPOLYLINE without a closing segment", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LWPOLYLINE"],
        [8, "Outline"],
        [90, 3],
        [70, 0], // not closed
        [10, 0],
        [20, 0],
        [10, 4],
        [20, 0],
        [10, 0],
        [20, 3],
        ...END_OF_FILE,
      ),
    );

    expect(Array.from(model.meshes[0]?.indices ?? [])).toEqual([0, 1, 1, 2]);
  });

  it("flags a nonzero LWPOLYLINE bulge instead of guessing a curve", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LWPOLYLINE"],
        [8, "0"],
        [90, 2],
        [70, 0],
        [10, 0],
        [20, 0],
        [42, 0.5],
        [10, 4],
        [20, 0],
        ...END_OF_FILE,
      ),
    );

    // Still decoded as a straight segment.
    expect(Array.from(model.meshes[0]?.indices ?? [])).toEqual([0, 1]);
    const diagnostic = model.diagnostics.find(
      (d) => d.code === "lwpolyline-bulge-ignored",
    );
    expect(diagnostic?.severity).toBe("warning");
  });

  it("groups entities into one mesh per layer", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [8, "A"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 0],
        [0, "LINE"],
        [8, "B"],
        [10, 0],
        [20, 0],
        [11, 0],
        [21, 1],
        [0, "LINE"],
        [8, "A"],
        [10, 1],
        [20, 0],
        [11, 1],
        [21, 1],
        ...END_OF_FILE,
      ),
    );

    expect(model.meshes.map((m) => m.name).sort()).toEqual(["A", "B"]);
    const layerA = model.meshes.find((m) => m.name === "A");
    // Two LINEs on layer A -> 4 vertices, 2 independent segments.
    expect(layerA?.positions).toHaveLength(4 * 3);
    expect(Array.from(layerA?.indices ?? [])).toEqual([0, 1, 2, 3]);
  });

  it("defaults to layer '0' when an entity carries no layer code", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
        ...END_OF_FILE,
      ),
    );

    expect(model.meshes[0]?.name).toBe("0");
  });

  it("converts inches to millimetres via $INSUNITS", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...insunitsHeader(1),
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [8, "0"],
        [10, 1],
        [20, 0],
        [11, 2],
        [21, 0],
        ...END_OF_FILE,
      ),
    );

    // Float32 can't store 25.4/50.8 exactly, so compare with tolerance
    // rather than expecting an exact bit-for-bit match.
    const positions = Array.from(model.meshes[0]?.positions ?? []);
    [25.4, 0, 0, 50.8, 0, 0].forEach((expected, i) => {
      expect(positions[i]).toBeCloseTo(expected, 4);
    });
  });

  it("reports units-assumed-mm when $INSUNITS is absent", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [8, "0"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
        ...END_OF_FILE,
      ),
    );

    const diagnostic = model.diagnostics.find(
      (d) => d.code === "units-assumed-mm",
    );
    expect(diagnostic?.severity).toBe("warning");
  });

  it("counts skipped unsupported entities and malformed supported ones separately", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(
        ...ENTITIES_HEADER,
        [0, "TEXT"],
        [8, "0"],
        [1, "hello"],
        [0, "INSERT"],
        [8, "0"],
        [2, "Block1"],
        [0, "LINE"], // malformed: no endpoint (11/21)
        [8, "0"],
        [10, 0],
        [20, 0],
        [0, "LINE"], // valid
        [8, "0"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
        ...END_OF_FILE,
      ),
    );

    expect(model.meshes).toHaveLength(1); // only the valid LINE decoded

    const skipped = model.diagnostics.find(
      (d) => d.code === "unsupported-entities-skipped",
    );
    expect(skipped?.message).toContain("TEXT(1)");
    expect(skipped?.message).toContain("INSERT(1)");

    const malformed = model.diagnostics.find(
      (d) => d.code === "malformed-entities-skipped",
    );
    expect(malformed?.message).toContain("LINE(1)");
  });

  it("reports malformed-group-code-lines for a non-numeric code line", () => {
    // Appended after a complete, well-formed file (an even number of lines
    // so far), so this lands cleanly as its own (code, value) pair rather
    // than cascading into the real content the way a stray line inserted
    // *inside* the token stream would (every pairing after it would shift
    // by one line, since code/value lines always alternate one per line).
    const text =
      pairsToText([
        ...ENTITIES_HEADER,
        [0, "LINE"],
        [8, "0"],
        [10, 0],
        [20, 0],
        [11, 1],
        [21, 1],
        ...END_OF_FILE,
      ]) + "\nNOT_A_CODE\nignored";

    const model = new DxfDecodeEngine().transform(encoder.encode(text));

    expect(model.meshes).toHaveLength(1); // the real LINE still decodes
    const diagnostic = model.diagnostics.find(
      (d) => d.code === "malformed-group-code-lines",
    );
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("1 line(s)");
  });

  it("reports no-supported-entities when the file has only unsupported types", () => {
    const model = new DxfDecodeEngine().transform(
      dxf(...ENTITIES_HEADER, [0, "TEXT"], [8, "0"], [1, "hi"], ...END_OF_FILE),
    );

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics[0]?.code).toBe("no-supported-entities");
    expect(model.diagnostics[0]?.severity).toBe("error");
  });

  it("reports invalid-dxf when there is no ENTITIES section at all", () => {
    const model = new DxfDecodeEngine().transform(
      encoder.encode("this is not a dxf file"),
    );

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toEqual([
      {
        severity: "error",
        code: "invalid-dxf",
        message:
          "No ENTITIES section found — this does not look like a valid DXF file.",
      },
    ]);
  });
});
