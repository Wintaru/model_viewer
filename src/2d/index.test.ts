import { describe, expect, it } from "vitest";
import { LineSegments, type LineBasicMaterial, type Object3D } from "three";
import {
  frameOrthographicCamera,
  setLayerVisible,
  toThreeDrawing,
} from "./index";
import type { DecodedMesh, DecodedModel } from "../common";

function lineMesh(overrides: Partial<DecodedMesh> = {}): DecodedMesh {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0]),
    normals: new Float32Array(6),
    indices: new Uint32Array([0, 1]),
    faces: [],
    topology: "lines",
    ...overrides,
  };
}

function modelWith(meshes: readonly DecodedMesh[]): DecodedModel {
  return { units: "mm", meshes, tree: [], metadata: {}, diagnostics: [] };
}

/** Same "fail with a clear message" precedent as toThree's meshChildAt. */
function lineSegmentsChildAt(object: Object3D, index: number): LineSegments {
  const child = object.children[index];
  if (!(child instanceof LineSegments)) {
    throw new Error(
      `Expected a LineSegments at children[${index}], got ${child?.type ?? "nothing"}`,
    );
  }
  return child as LineSegments;
}

describe("toThreeDrawing", () => {
  it("builds one LineSegments per DecodedMesh, named after its layer", () => {
    const mesh = lineMesh({ name: "Layer1" });

    const drawing = toThreeDrawing(modelWith([mesh]));

    expect(drawing.children).toHaveLength(1);
    const line = lineSegmentsChildAt(drawing, 0);
    expect(line.name).toBe("Layer1");
    expect(line.geometry.getAttribute("position").array).toEqual(
      mesh.positions,
    );
    expect(line.geometry.getIndex()?.array).toEqual(mesh.indices);
  });

  it("builds independent LineSegments objects for each mesh, in order", () => {
    const drawing = toThreeDrawing(
      modelWith([lineMesh({ name: "A" }), lineMesh({ name: "B" })]),
    );

    expect(drawing.children.map((c) => c.name)).toEqual(["A", "B"]);
  });

  it("defaults to a plain grey line colour when none is given", () => {
    const drawing = toThreeDrawing(modelWith([lineMesh()]));

    const material = lineSegmentsChildAt(drawing, 0)
      .material as LineBasicMaterial;
    expect(material.color.getHex()).toBe(0x9a9a9a);
  });

  it("uses the mesh's own colour when one is given", () => {
    const mesh = lineMesh({ color: [1, 0, 0] });

    const drawing = toThreeDrawing(modelWith([mesh]));

    const material = lineSegmentsChildAt(drawing, 0)
      .material as LineBasicMaterial;
    expect(material.color.getHex()).toBe(0xff0000);
  });

  it("treats colour as sRGB, not three.js's linear working space", () => {
    // Same reasoning as toThree's equivalent test: a mid-range value is the
    // only kind that can catch a missing sRGB conversion (0 and 1 are fixed
    // points of the conversion).
    const mesh = lineMesh({ color: [0.5, 0.5, 0.5] });

    const drawing = toThreeDrawing(modelWith([mesh]));

    const material = lineSegmentsChildAt(drawing, 0)
      .material as LineBasicMaterial;
    expect(material.color.getHex()).toBe(0x808080);
  });

  it("throws when given a 'triangles'-topology mesh instead of 'lines'", () => {
    const triangleMesh = lineMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      topology: "triangles",
    });

    expect(() => toThreeDrawing(modelWith([triangleMesh]))).toThrow(TypeError);
  });

  it("throws when topology is absent, since 'triangles' is the default", () => {
    // Built directly, not via lineMesh's override spread: exactOptionalPropertyTypes
    // rejects an explicit `topology: undefined`, so an absent key is the only
    // way to construct this case.
    const untaggedMesh: DecodedMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0]),
      normals: new Float32Array(6),
      indices: new Uint32Array([0, 1]),
      faces: [],
    };

    expect(() => toThreeDrawing(modelWith([untaggedMesh]))).toThrow(TypeError);
  });
});

describe("setLayerVisible", () => {
  it("toggles the named layer's visibility without affecting others", () => {
    const drawing = toThreeDrawing(
      modelWith([lineMesh({ name: "A" }), lineMesh({ name: "B" })]),
    );

    setLayerVisible(drawing, "B", false);

    expect(drawing.children.find((c) => c.name === "A")?.visible).toBe(true);
    expect(drawing.children.find((c) => c.name === "B")?.visible).toBe(false);
  });

  it("does nothing when no child matches the given layer name", () => {
    const drawing = toThreeDrawing(modelWith([lineMesh({ name: "A" })]));

    expect(() => setLayerVisible(drawing, "DoesNotExist", false)).not.toThrow();
    expect(drawing.children[0]?.visible).toBe(true);
  });
});

describe("frameOrthographicCamera", () => {
  it("frames a square drawing with even padding on all sides", () => {
    // Bounds 0..10 x 0..10, a square viewport (aspect 1): width == height,
    // so the fit is symmetric and the padding factor (1.05) is the only
    // thing separating the frustum from the raw bounds.
    const mesh = lineMesh({
      positions: new Float32Array([0, 0, 0, 10, 10, 0]),
      indices: new Uint32Array([0, 1]),
    });

    const camera = frameOrthographicCamera(modelWith([mesh]), 1);

    // left/right/top/bottom are camera-local (three.js derives the
    // projection's center from (right+left)/2 and (top+bottom)/2), so a
    // centred drawing's frustum is symmetric around 0 regardless of where
    // in world space the drawing itself sits — world-space centering is
    // camera.position's job, checked separately below.
    expect(camera.left).toBeCloseTo(-5.25, 5);
    expect(camera.right).toBeCloseTo(5.25, 5);
    expect(camera.bottom).toBeCloseTo(-5.25, 5);
    expect(camera.top).toBeCloseTo(5.25, 5);
    expect(camera.position.x).toBeCloseTo(5, 5);
    expect(camera.position.y).toBeCloseTo(5, 5);
  });

  it("pads the shorter axis to fit the viewport aspect without distorting the drawing", () => {
    // Bounds 0..20 (width) x 0..10 (height) -> a 2:1 box, viewed through a
    // square (1:1) viewport. The viewport is narrower (relatively) than the
    // box, so height must grow to match width, not the other way around --
    // the wider axis is always the binding constraint here.
    const mesh = lineMesh({
      positions: new Float32Array([0, 0, 0, 20, 10, 0]),
      indices: new Uint32Array([0, 1]),
    });

    const camera = frameOrthographicCamera(modelWith([mesh]), 1);

    expect(camera.right - camera.left).toBeCloseTo(21, 5); // 20 * 1.05
    expect(camera.top - camera.bottom).toBeCloseTo(21, 5); // padded to match
    // Still centred on the original box's centre, and still contains it —
    // translate the camera-local frustum into world space via
    // camera.position (see the test above) before comparing to the box.
    expect(camera.position.x + camera.left).toBeLessThanOrEqual(0);
    expect(camera.position.x + camera.right).toBeGreaterThanOrEqual(20);
    expect(camera.position.y + camera.bottom).toBeLessThanOrEqual(0);
    expect(camera.position.y + camera.top).toBeGreaterThanOrEqual(10);
  });

  it("pads the shorter axis the other way when the viewport is wider than the box", () => {
    // Bounds 0..5 (width) x 0..20 (height), viewed through a wide (2:1)
    // viewport this time -- now width must grow to match height * aspect.
    const mesh = lineMesh({
      positions: new Float32Array([0, 0, 0, 5, 20, 0]),
      indices: new Uint32Array([0, 1]),
    });

    const camera = frameOrthographicCamera(modelWith([mesh]), 2);

    expect(camera.top - camera.bottom).toBeCloseTo(21, 5); // 20 * 1.05
    expect(camera.right - camera.left).toBeCloseTo(42, 5); // 21 * aspect 2
    // Translate the camera-local frustum into world space before checking
    // it still contains the box — see the first test above.
    expect(camera.position.x + camera.left).toBeLessThanOrEqual(0);
    expect(camera.position.x + camera.right).toBeGreaterThanOrEqual(5);
  });

  it("floors a degenerate zero-extent axis instead of dividing by zero", () => {
    // A perfectly horizontal line has zero height.
    const mesh = lineMesh({
      positions: new Float32Array([0, 0, 0, 10, 0, 0]),
      indices: new Uint32Array([0, 1]),
    });

    const camera = frameOrthographicCamera(modelWith([mesh]), 1);

    expect(Number.isFinite(camera.top)).toBe(true);
    expect(Number.isFinite(camera.bottom)).toBe(true);
    expect(camera.top).toBeGreaterThan(camera.bottom);
  });

  it("frames a small default view when the model has no geometry at all", () => {
    const camera = frameOrthographicCamera(modelWith([]), 1);

    expect(Number.isFinite(camera.left)).toBe(true);
    expect(Number.isFinite(camera.right)).toBe(true);
    expect(Number.isFinite(camera.top)).toBe(true);
    expect(Number.isFinite(camera.bottom)).toBe(true);
    expect(camera.right).toBeGreaterThan(camera.left);
    expect(camera.top).toBeGreaterThan(camera.bottom);
  });
});
