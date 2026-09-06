/**
 * The interactive demo: pick any supported file, see it rendered, pan,
 * zoom and (for a 3D shape) rotate it, then clear and try another one.
 *
 * Unlike library-demo.ts — a smoke test proving each format decodes at all,
 * against fixed, committed fixtures — this is real, designed viewer work
 * (D7, WAYFINDER.md), scoped the way D0 asks of a demo page: show what a
 * caller can build, stay small enough to read as an example.
 *
 * Fixes a real, reported problem in the smoke demo: DXF was rendered
 * through the same shared, orbiting PerspectiveCamera as every 3D shape, so
 * a 2D drawing incorrectly rotated in 3D space along with everything else.
 * Here, a drawing (any model whose meshes are all `topology: 'lines'`) gets
 * its own OrthographicCamera (`frameOrthographicCamera`, the `/2d` adapter)
 * and `OrbitControls` with rotation disabled — pan and zoom only, never
 * rotate, matching how a real 2D drawing viewer behaves. A 3D shape keeps a
 * normal orbiting `PerspectiveCamera`.
 *
 * Bundled to interactive-demo.bundle.js by scripts/build-library-demo.mjs,
 * the same way library-demo.ts is — see that script's comments. Reuses the
 * exact same worker bundles (occt.worker.bundle.js,
 * solidworks.worker.bundle.js, dxf.worker.bundle.js) and wasm asset that
 * script already produces; this page needs no new build output beyond its
 * own bundle.
 */
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from "three";
// three ships this as a real ESM module under examples/jsm — not part of
// the core `three` package export map, so a real consumer's bundler
// resolves it the same way this demo's does: a plain path into the
// installed package, not a special case.
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ModelLoader,
  ModuleRegistry,
  type DecodedModel,
  type DxfDecoder,
  type SolidWorksDecoder,
  type StepDecoder,
} from "../src/index";
import { DxfDecodeEngineProxy } from "../src/engine/DxfDecodeEngineProxy";
import { OcctDecodeEngineProxy } from "../src/engine/OcctDecodeEngineProxy";
import { SolidWorksDecodeEngineProxy } from "../src/engine/SolidWorksDecodeEngineProxy";
import { frameOrthographicCamera, toThreeDrawing } from "../src/2d/index";
import { toThree } from "../src/three/index";

const STEP_WASM_URL = "occt-import-js.wasm";
const STEP_WORKER_URL = "occt.worker.bundle.js";
const SOLIDWORKS_WORKER_URL = "solidworks.worker.bundle.js";
const DXF_WORKER_URL = "dxf.worker.bundle.js";

// Same shape as library-demo.ts's own createStepDecoders /
// createSolidWorksDecoders / createDxfDecoders, and the same reason: this
// build has no bundler that rewrites `new Worker(new URL(...))` on its own,
// so each worker's bundled output filename is supplied by hand instead of
// relying on ModelLoader's parameterless defaults.
function createStepDecoders(): ModuleRegistry<"step", StepDecoder> {
  return new ModuleRegistry<"step", StepDecoder>({
    step: () =>
      Promise.resolve(
        new OcctDecodeEngineProxy(
          STEP_WASM_URL,
          () => new Worker(STEP_WORKER_URL, { type: "module" }),
        ),
      ),
  });
}

function createSolidWorksDecoders(): ModuleRegistry<
  "solidworks",
  SolidWorksDecoder
> {
  return new ModuleRegistry<"solidworks", SolidWorksDecoder>({
    solidworks: () =>
      Promise.resolve(
        new SolidWorksDecodeEngineProxy(
          () => new Worker(SOLIDWORKS_WORKER_URL, { type: "module" }),
        ),
      ),
  });
}

function createDxfDecoders(): ModuleRegistry<"dxf", DxfDecoder> {
  return new ModuleRegistry<"dxf", DxfDecoder>({
    dxf: () =>
      Promise.resolve(
        new DxfDecodeEngineProxy(
          () => new Worker(DXF_WORKER_URL, { type: "module" }),
        ),
      ),
  });
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing #${id} element in interactive-demo.html.`);
  }
  return element as T;
}

/**
 * A model is a drawing, not a 3D shape, exactly when every mesh it holds
 * is line topology — the same signal `DxfDecodeEngine` sets and
 * `toThreeDrawing` requires (D6, WAYFINDER.md). An empty model (no meshes
 * at all, e.g. a decode that only produced diagnostics) is not a drawing:
 * there is nothing to frame an orthographic camera to.
 */
function isDrawing(model: DecodedModel): boolean {
  return (
    model.meshes.length > 0 &&
    model.meshes.every((mesh) => mesh.topology === "lines")
  );
}

/** Smallest bounding radius {@link frame3DCamera} will frame — the 3D
 * equivalent of `/2d`'s `MIN_FRAMED_EXTENT_MM`, guarding the same
 * divide-by-zero case: a model that is a single point, or otherwise has
 * zero extent in every direction. */
const MIN_BOUNDING_RADIUS = 1;
/** Extra headroom (as a fraction of the fitted distance) so a model's
 * silhouette doesn't sit flush against the viewport edge — the 3D
 * equivalent of `/2d`'s `CAMERA_PADDING_FACTOR`. */
const CAMERA_PADDING_FACTOR = 1.3;
/** A fixed oblique viewing direction, independent of the model's own
 * scale — chosen to look like a normal three-quarter product-shot angle
 * rather than straight down any one axis. */
const VIEW_DIRECTION = new Vector3(70, 60, 90).normalize();

/**
 * `content`'s bounding sphere in world space, via three.js's own `Box3` /
 * `Sphere` rather than hand-rolled math over `DecodedMesh.positions` — that
 * would read pre-transform, mesh-local coordinates, silently wrong the
 * moment a `SceneNode.transform` isn't the identity (an assembly's parts
 * placed away from their own mesh origin, say — untested but real v1
 * surface, `src/common/SceneNode.ts`). `Box3().setFromObject` walks
 * `content`'s actual world matrices, the same ones `toThree` just built it
 * with, so this frames exactly what the renderer is about to draw.
 */
function boundingSphere(content: Object3D): Sphere {
  const sphere = new Box3()
    .setFromObject(content)
    .getBoundingSphere(new Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    // No geometry at all (an empty model) — box.getBoundingSphere returns
    // a non-finite radius from an empty Box3, the same "frame a small
    // default view instead of propagating NaN" posture `/2d`'s
    // computeBounds takes for the equivalent empty-model case.
    sphere.center.set(0, 0, 0);
    sphere.radius = MIN_BOUNDING_RADIUS;
  } else {
    sphere.radius = Math.max(sphere.radius, MIN_BOUNDING_RADIUS);
  }
  return sphere;
}

/**
 * Builds a `PerspectiveCamera` positioned to frame `content`'s whole
 * bounding sphere from a fixed oblique angle, whatever scale the model
 * itself turns out to be — an arbitrary file a caller uploads could be a
 * few millimetres or several metres across, unlike every fixture the smoke
 * demo (library-demo.ts) uses, which are all hand-picked to suit one fixed
 * camera position. Also returns the point the camera looks at, so the
 * caller can point `OrbitControls.target` at the same place (its default,
 * the world origin, is wrong for any model not centred there).
 */
function frame3DCamera(
  content: Object3D,
  aspect: number,
): { camera: PerspectiveCamera; target: Vector3 } {
  const sphere = boundingSphere(content);
  const camera = new PerspectiveCamera(
    50,
    aspect,
    sphere.radius / 100,
    sphere.radius * 100,
  );
  // The camera's own `fov` is vertical; on a viewport narrower than it is
  // tall, the horizontal frustum is the tighter constraint instead, so the
  // distance needed to fit the sphere within each is computed separately
  // and the larger one wins — otherwise a wide model on a narrow viewport
  // would clip left and right.
  const verticalFovRad = (camera.fov * Math.PI) / 180;
  const horizontalFovRad = 2 * Math.atan(Math.tan(verticalFovRad / 2) * aspect);
  const distance =
    Math.max(
      sphere.radius / Math.sin(verticalFovRad / 2),
      sphere.radius / Math.sin(horizontalFovRad / 2),
    ) * CAMERA_PADDING_FACTOR;
  camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, distance);
  camera.lookAt(sphere.center);
  return { camera, target: sphere.center.clone() };
}

interface Disposable3D extends Object3D {
  readonly geometry: { dispose(): void };
  readonly material: { dispose(): void } | readonly { dispose(): void }[];
}

/**
 * Duck-typed on `geometry`/`material` rather than enumerated by concrete
 * class (`Mesh`, `LineSegments`) — `toThree` and `toThreeDrawing` only ever
 * produce those two today, but a class-by-class list would silently leak
 * GPU resources on every clear/reload the day either adapter grows a new
 * renderable type (a point cloud's `Points`, say), with nothing here to
 * notice or fail loudly.
 */
function isDisposable3D(object: Object3D): object is Disposable3D {
  return "geometry" in object && "material" in object;
}

/** Releases GPU resources for everything under `root` before it is discarded. */
function disposeObject3D(root: Object3D): void {
  root.traverse((child) => {
    if (!isDisposable3D(child)) {
      return;
    }
    child.geometry.dispose();
    const material = child.material;
    if (Array.isArray(material)) {
      for (const one of material) one.dispose();
    } else {
      material.dispose();
    }
  });
}

function main(): void {
  const status = requiredElement<HTMLElement>("status");
  const fileInput = requiredElement<HTMLInputElement>("file-input");
  const dropZone = requiredElement<HTMLElement>("drop-zone");
  const clearButton = requiredElement<HTMLButtonElement>("clear-button");
  const viewport = requiredElement<HTMLElement>("viewport");

  const loader = new ModelLoader(
    undefined,
    undefined,
    createStepDecoders(),
    createSolidWorksDecoders(),
    undefined,
    createDxfDecoders(),
  );

  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 0.6));
  const key = new DirectionalLight(0xffffff, 2);
  key.position.set(1, 2, 3);
  scene.add(key);

  const renderer = new WebGLRenderer({ antialias: true });
  viewport.appendChild(renderer.domElement);

  function aspect(): number {
    return viewport.clientWidth / Math.max(1, viewport.clientHeight);
  }

  function defaultCamera(): PerspectiveCamera {
    const perspective = new PerspectiveCamera(50, aspect(), 0.1, 1000);
    perspective.position.set(70, 60, 90);
    perspective.lookAt(0, 0, 0);
    return perspective;
  }

  let camera: PerspectiveCamera | OrthographicCamera = defaultCamera();
  let controls = new OrbitControls(camera, renderer.domElement);
  let content: Object3D | undefined;

  function clear(): void {
    if (content !== undefined) {
      scene.remove(content);
      disposeObject3D(content);
      content = undefined;
    }
    controls.dispose();
    camera = defaultCamera();
    controls = new OrbitControls(camera, renderer.domElement);
    status.textContent = "Choose a file to load it.";
    fileInput.value = "";
  }

  function showModel(model: DecodedModel, name: string): void {
    if (content !== undefined) {
      scene.remove(content);
      disposeObject3D(content);
    }
    controls.dispose();

    const drawing = isDrawing(model);
    let target: Vector3;
    if (drawing) {
      camera = frameOrthographicCamera(model, aspect());
      // frameOrthographicCamera positions the camera at (centerX, centerY,
      // distance) and looks straight down -Z at (centerX, centerY, 0) — so
      // the look-at point is recoverable from the camera's own x/y.
      target = new Vector3(camera.position.x, camera.position.y, 0);
      content = toThreeDrawing(model);
    } else {
      // Built before frame3DCamera, which frames content's own world-space
      // bounding sphere (via Box3().setFromObject) rather than raw,
      // pre-transform mesh positions — the only way this stays correct
      // once a SceneNode carries a non-identity transform (an assembly's
      // parts placed away from their own mesh origin, say).
      content = toThree(model);
      const framed = frame3DCamera(content, aspect());
      camera = framed.camera;
      target = framed.target;
    }
    scene.add(content);

    controls = new OrbitControls(camera, renderer.domElement);
    // OrbitControls.target defaults to the world origin, not wherever the
    // camera was actually pointed — its first update() call re-aims the
    // camera at that default target, which would skew or blank the view
    // for any model not centred at (0, 0, 0) (measured by hand: this
    // silently rendered nothing at all for a real 3D file before this
    // fix). Both branches above hand back exactly the point their camera
    // already looks at, so this line is the same regardless of which one
    // ran.
    controls.target.copy(target);
    // A drawing's camera looks straight down -Z at a flat model, so
    // rotating it out of that plane would only ever show an edge-on,
    // unreadable view — pan and zoom are the only navigation a 2D drawing
    // viewer needs (WAYFINDER.md's D6). A 3D shape keeps full orbit.
    controls.enableRotate = !drawing;

    const diagnosticText = model.diagnostics
      .map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`)
      .join(" ");
    const shapeSummary =
      model.meshes.length === 0
        ? "no geometry"
        : `${model.meshes.length} mesh(es), ${drawing ? "2D drawing" : "3D shape"}`;
    status.textContent = diagnosticText
      ? `${name}: ${shapeSummary}. ${diagnosticText}`
      : `${name}: ${shapeSummary}.`;
  }

  async function loadFile(file: File): Promise<void> {
    status.textContent = `Loading ${file.name}…`;
    try {
      const model = await loader.load(file);
      showModel(model, file.name);
    } catch (error) {
      status.textContent = `${file.name}: failed to load — ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file !== undefined) {
      void loadFile(file);
    }
  });

  clearButton.addEventListener("click", clear);

  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("drag-active");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.remove("drag-active");
    });
  }
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file !== undefined) {
      void loadFile(file);
    }
  });

  function resize(): void {
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    if (camera instanceof PerspectiveCamera) {
      camera.aspect = aspect();
      camera.updateProjectionMatrix();
    } else {
      // OrthographicCamera: widen or narrow the horizontal extent to match
      // the new aspect, around the current center, leaving the vertical
      // extent and the camera's `zoom` (how OrbitControls implements zoom
      // on this camera type) untouched — so a resize never resets
      // whatever pan/zoom the drawing was left at.
      const centerX = (camera.left + camera.right) / 2;
      const height = camera.top - camera.bottom;
      const halfWidth = (height * aspect()) / 2;
      camera.left = centerX - halfWidth;
      camera.right = centerX + halfWidth;
      camera.updateProjectionMatrix();
    }
  }
  window.addEventListener("resize", resize);
  resize();

  status.textContent = "Choose a file to load it.";

  function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

main();
