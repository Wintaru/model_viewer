import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  SRGBColorSpace,
} from "three";
import type { DecodedMesh, DecodedModel } from "../common";

/** Plain mid-grey — the same default `toThree` uses for an uncoloured mesh. */
const DEFAULT_LINE_COLOR = 0x9a9a9a;

/**
 * Fraction of extra room left around a drawing's bounds when framing a
 * camera to it, so geometry doesn't sit flush against the viewport edge.
 */
const CAMERA_PADDING_FACTOR = 1.05;

/**
 * The smallest extent {@link frameOrthographicCamera} will frame along
 * either axis, in the drawing's own units (millimetres). Without this, a
 * drawing that is perfectly horizontal or vertical — a single LINE entity
 * along one axis, say — has zero height or width, which would make the
 * aspect-ratio fit below divide by zero.
 */
const MIN_FRAMED_EXTENT_MM = 1;

const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;
/** Arbitrary — an orthographic camera's zoom doesn't depend on distance,
 * this just has to clear the drawing's z=0 plane within near/far. */
const CAMERA_DISTANCE = 100;

/**
 * The `/2d` entry point (D6, WAYFINDER.md). A pure, stateless transform
 * from the renderer-agnostic {@link DecodedModel} to a three.js scene graph
 * — the second adapter D6 called for, sitting beside `/three` rather than
 * inside it, because a drawing's navigation (orthographic, pan/zoom, layer
 * visibility) has nothing in common with `/three`'s orbiting 3D viewer.
 *
 * Mirrors `toThree`'s shape deliberately: same pure-function style, same
 * "kept out of the package root so headless work never pulls in three.js"
 * reasoning (D10, SPEC.md section 8) — just building `LineSegments` instead
 * of `Mesh`, and framing an orthographic camera instead of leaving the host
 * to add `OrbitControls`.
 */
export function toThreeDrawing(model: DecodedModel): Group {
  const root = new Group();
  for (const mesh of model.meshes) {
    root.add(buildLineSegments(mesh));
  }
  return root;
}

function buildLineSegments(mesh: DecodedMesh): LineSegments {
  // A genuine internal-consistency check, not a caller-input validation —
  // the same posture toThree's mesh-index check takes (src/three/index.ts).
  // 'lines' is DecodedMesh's default-absent value ("triangles" wins when
  // topology is undefined), so a triangle-topology mesh reaching here would
  // have its index triples silently reinterpreted as line-segment pairs,
  // rendering confidently wrong geometry instead of failing.
  if (mesh.topology !== "lines") {
    throw new TypeError(
      `toThreeDrawing only renders 'lines'-topology meshes, got ${mesh.topology ?? "'triangles' (the default)"}. Render this model through toThree (the /three adapter) instead.`,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));

  const material = new LineBasicMaterial({ color: colorFor(mesh.color) });
  const object = new LineSegments(geometry, material);
  if (mesh.name !== undefined) {
    // The DXF layer name (DecodedMesh's doc comment) — setLayerVisible
    // below toggles visibility by this same name.
    object.name = mesh.name;
  }
  return object;
}

function colorFor(color: DecodedMesh["color"]): Color {
  if (color === undefined) {
    return new Color(DEFAULT_LINE_COLOR);
  }
  // Same sRGB-to-linear conversion toThree's materialFor documents, and
  // for the same reason: DecodedMesh.color is sRGB, not three.js's linear
  // working space.
  return new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace);
}

/**
 * Toggles one layer's visibility by name — the DXF layer name `name`
 * carries on each `LineSegments` child `toThreeDrawing` built. A no-op,
 * not a thrown error, when `layerName` doesn't match any child: unlike
 * `toThree`'s mesh-index check (which guards a genuine internal
 * consistency invariant of a `DecodedModel`), a caller-supplied layer name
 * with nothing to match is an ordinary UI case — a layer toggled after the
 * model it belonged to was replaced, say — not a sign of a malformed model.
 */
export function setLayerVisible(
  drawing: Group,
  layerName: string,
  visible: boolean,
): void {
  const layer = drawing.children.find((child) => child.name === layerName);
  if (layer !== undefined) {
    layer.visible = visible;
  }
}

interface Bounds2D {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function computeBounds(model: DecodedModel): Bounds2D {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const mesh of model.meshes) {
    const { positions } = mesh;
    for (let i = 0; i + 1 < positions.length; i += 3) {
      const x = positions[i] ?? 0;
      const y = positions[i + 1] ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) {
    // No geometry at all (an empty model, or every mesh empty) — frame a
    // small default view around the origin rather than an Infinity-tainted
    // box that would propagate NaN through every calculation below.
    return {
      minX: -MIN_FRAMED_EXTENT_MM,
      maxX: MIN_FRAMED_EXTENT_MM,
      minY: -MIN_FRAMED_EXTENT_MM,
      maxY: MIN_FRAMED_EXTENT_MM,
    };
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Builds an `OrthographicCamera` framed to `model`'s bounds, fit to
 * `aspect` (viewport width / height) without distorting the drawing —
 * whichever axis the bounds are proportionally smaller on on gets padded
 * out to match the viewport's shape, rather than stretching the geometry
 * itself. Looks down the -Z axis at the drawing's centre, matching how
 * DXF's decoded geometry always lands on the z=0 plane (`DxfDecodeEngine`).
 *
 * A pure function, like `toThreeDrawing` — call again whenever the model or
 * the viewport's aspect ratio changes (e.g. a window resize), rather than
 * mutating a held camera's frustum in place.
 */
export function frameOrthographicCamera(
  model: DecodedModel,
  aspect: number,
): OrthographicCamera {
  const bounds = computeBounds(model);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const width =
    Math.max(bounds.maxX - bounds.minX, MIN_FRAMED_EXTENT_MM) *
    CAMERA_PADDING_FACTOR;
  const height =
    Math.max(bounds.maxY - bounds.minY, MIN_FRAMED_EXTENT_MM) *
    CAMERA_PADDING_FACTOR;

  const boundsAspect = width / height;
  const [frameWidth, frameHeight] =
    boundsAspect >= aspect
      ? [width, width / aspect]
      : [height * aspect, height];

  const halfWidth = frameWidth / 2;
  const halfHeight = frameHeight / 2;
  // OrthographicCamera's left/right/top/bottom are camera-local — offset
  // from the camera's own position and view direction, not world
  // coordinates (three.js's own updateProjectionMatrix() derives the
  // projection's center from (right+left)/2 and (top+bottom)/2, so a
  // nonzero pair here shifts the frustum off-axis, the same "lens shift"
  // a real asymmetric-frustum camera has). World-space centering belongs
  // entirely in position + lookAt below; centering it again here as well
  // would shift the frustum by (centerX, centerY) a second time — measured
  // by hand in a real browser against a model not centred at the origin
  // (WAYFINDER.md's interactive-demo work), where it cropped and shifted
  // the rendered drawing instead of centering it.
  const camera = new OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    CAMERA_NEAR,
    CAMERA_FAR,
  );
  camera.position.set(centerX, centerY, CAMERA_DISTANCE);
  camera.lookAt(centerX, centerY, 0);
  return camera;
}
