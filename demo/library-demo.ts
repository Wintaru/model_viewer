/**
 * Slice 1 commit 14 smoke demo: proves `ModelLoader` and `toThree` work
 * together end to end, in a real browser — not just under Vitest. See
 * SPEC.md section 10: "a smoke demo, not the designed viewer." The actual
 * viewer UI is decision D7, still open (WAYFINDER.md).
 *
 * Self-contained: the geometry below is a hand-built binary STL, not a
 * fetched file, so this demo needs no test corpus and no `pnpm assets`.
 * Bundled to library-demo.bundle.js by scripts/build-library-demo.mjs into a
 * classic, non-module script — a `<script type="module">` fails to load
 * over `file://` in every major browser (each cross-file import is blocked
 * as cross-origin), which is why demo/viewer.html takes the same
 * everything-inlined approach.
 */
import {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
} from "three";
import { fromBuffer, ModelLoader } from "../src/index";
import { toThree } from "../src/three/index";

interface Triangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

type Quad = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** Splits one flat, axis-aligned face into the two triangles STL needs. */
function face(
  normal: readonly [number, number, number],
  corners: Quad,
): readonly [Triangle, Triangle] {
  const [a, b, c, d] = corners;
  return [
    { normal, vertices: [a, b, c] },
    { normal, vertices: [a, c, d] },
  ];
}

// A 40mm cube, corners listed counter-clockwise as seen from outside each
// face (the standard convention: normal follows the right-hand rule from
// that winding), centred so the demo camera can just look at the origin.
const HALF = 20;
const CUBE_TRIANGLES: readonly Triangle[] = [
  ...face(
    [1, 0, 0],
    [
      [HALF, -HALF, -HALF],
      [HALF, HALF, -HALF],
      [HALF, HALF, HALF],
      [HALF, -HALF, HALF],
    ],
  ),
  ...face(
    [-1, 0, 0],
    [
      [-HALF, -HALF, HALF],
      [-HALF, HALF, HALF],
      [-HALF, HALF, -HALF],
      [-HALF, -HALF, -HALF],
    ],
  ),
  ...face(
    [0, 1, 0],
    [
      [-HALF, HALF, -HALF],
      [-HALF, HALF, HALF],
      [HALF, HALF, HALF],
      [HALF, HALF, -HALF],
    ],
  ),
  ...face(
    [0, -1, 0],
    [
      [-HALF, -HALF, HALF],
      [-HALF, -HALF, -HALF],
      [HALF, -HALF, -HALF],
      [HALF, -HALF, HALF],
    ],
  ),
  ...face(
    [0, 0, 1],
    [
      [-HALF, -HALF, HALF],
      [HALF, -HALF, HALF],
      [HALF, HALF, HALF],
      [-HALF, HALF, HALF],
    ],
  ),
  ...face(
    [0, 0, -1],
    [
      [HALF, -HALF, -HALF],
      [-HALF, -HALF, -HALF],
      [-HALF, HALF, -HALF],
      [HALF, HALF, -HALF],
    ],
  ),
];

/** Same binary STL layout `MeshDecodeEngine` reads — see its test file. */
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
    offset += 2; // attribute byte count — unused
  }
  return bytes;
}

function statusElement(): HTMLElement {
  const element = document.getElementById("status");
  if (element === null) {
    throw new Error("Missing #status element in library-demo.html.");
  }
  return element;
}

function animate(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  spinning: Object3D,
): void {
  requestAnimationFrame(() => animate(renderer, scene, camera, spinning));
  spinning.rotation.y += 0.01;
  renderer.render(scene, camera);
}

async function main(): Promise<void> {
  const status = statusElement();

  const loader = new ModelLoader();
  const stl = fromBuffer(binaryStl(CUBE_TRIANGLES), "smoke-cube.stl");
  const model = await loader.load(stl);

  if (model.diagnostics.some((d) => d.severity === "error")) {
    status.textContent = model.diagnostics
      .map((d) => `${d.severity}: ${d.message}`)
      .join("\n");
    return;
  }
  status.textContent = `Loaded ${model.meshes.length} mesh(es), ${model.tree.length} scene node(s).`;

  const scene = new Scene();
  const object = toThree(model);
  scene.add(object);
  scene.add(new AmbientLight(0xffffff, 0.6));
  const key = new DirectionalLight(0xffffff, 2);
  key.position.set(1, 2, 3);
  scene.add(key);

  const camera = new PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.position.set(70, 60, 90);
  camera.lookAt(0, 0, 0);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate(renderer, scene, camera, object);
}

main().catch((error: unknown) => {
  statusElement().textContent = `Demo failed to start: ${String(error)}`;
});
