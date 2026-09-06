/**
 * Slice 1 commit 14's smoke demo, extended in slice 2 commit 7: proves
 * `ModelLoader` and `toThree` work together end to end, in a real browser —
 * not just under Vitest. See SPEC.md section 10: "a smoke demo, not the
 * designed viewer." The actual viewer UI is decision D7, still open
 * (WAYFINDER.md).
 *
 * Two separate proofs, with two different delivery constraints:
 *
 * - The STL cube is self-contained (hand-built bytes, no fetch) and needs
 *   no Worker, so it still works opened directly over `file://`, same as
 *   before commit 7.
 * - The STEP part (`nist-ftc-11.stp`, NIST's, usable without restriction —
 *   see demo/README.md) proves the slice 2 packaging decision: a real
 *   `.wasm` chunk fetched lazily, decoded off the main thread. That needs
 *   both `fetch` and `Worker`, and a real browser flatly refuses to
 *   construct a Worker at all from a `file://` page — confirmed by hand,
 *   not assumed; see DECISIONS.md — so this half only works served over
 *   http(s). Caught and reported in the status text rather than left as an
 *   uncaught rejection, so opening this file directly still shows the cube
 *   working exactly as it always has.
 * - The SolidWorks part (`nist-ctc-01.SLDPRT`, slice 3 commit 7) proves the
 *   same thing again for the native SolidWorks decoder: no wasm this time,
 *   but still a real `Worker`, so it carries the identical `file://`
 *   restriction and the same caught-and-reported failure mode as the STEP
 *   half. This is the same NIST part `viewer.html`'s Python-path proof
 *   already decodes — see demo/README.md's "the working case" screenshot —
 *   so a known-good bounding box exists to sanity-check against by eye.
 *
 * Bundled to library-demo.bundle.js by scripts/build-library-demo.mjs into a
 * classic, non-module script — a `<script type="module">` fails to load
 * over `file://` in every major browser (each cross-file import is blocked
 * as cross-origin), which is why demo/viewer.html takes the same
 * everything-inlined approach. occt.worker.ts and solidworks.worker.ts are
 * each bundled separately, by the same script, into
 * demo/occt.worker.bundle.js and demo/solidworks.worker.bundle.js: see that
 * script's comments.
 */
import {
  AmbientLight,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
} from "three";
import {
  fromBuffer,
  fromUrl,
  ModelLoader,
  ModuleRegistry,
  type SolidWorksDecoder,
  type StepDecoder,
} from "../src/index";
import { OcctDecodeEngineProxy } from "../src/engine/OcctDecodeEngineProxy";
import { SolidWorksDecodeEngineProxy } from "../src/engine/SolidWorksDecodeEngineProxy";
import { toThree } from "../src/three/index";

const STEP_WASM_URL = "occt-import-js.wasm";
const STEP_WORKER_URL = "occt.worker.bundle.js";
const STEP_FILE_URL = "nist-ftc-11.stp";
const SOLIDWORKS_WORKER_URL = "solidworks.worker.bundle.js";
const SOLIDWORKS_FILE_URL = "nist-ctc-01.SLDPRT";

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

/**
 * The STEP half of the demo's dispatch config. Constructing
 * `OcctDecodeEngineProxy` directly, rather than passing the plain wasm URL
 * string `ModelLoader`'s constructor also accepts (SPEC.md section 10
 * slice 2, commit 6), is demo-specific: this build has no bundler that
 * automatically rewrites `new Worker(new URL(...))` to point at wherever
 * it emits a split worker chunk (unlike Vite or webpack, which is exactly
 * what lets a real consumer just pass a URL and stop there). Here, that
 * rewriting is done by hand in scripts/build-library-demo.mjs, so the demo
 * has to point `createWorker` at the bundle's own output filename instead
 * of relying on the default.
 */
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

/**
 * The SolidWorks half of the demo's dispatch config — same reasoning as
 * `createStepDecoders`, minus the wasm URL: `SolidWorksDecodeEngineProxy`
 * takes no configuration but `createWorker`, so the only thing this demo
 * needs to override is where that worker's bundled chunk lives.
 */
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

/**
 * Loads `nist-ftc-11.stp` and adds it to `spinning`, offset so it doesn't
 * overlap the cube. Reports the outcome by appending to `status` rather
 * than replacing it, so the cube's own line stays visible either way.
 *
 * Loads through `fromUrl` (SPEC.md section 10 slice 4) rather than a manual
 * `fetch` + `fromBuffer`, proving the packaging decision for real: this
 * demo has no way to fetch a Range-limited prefix by hand the way
 * `UrlSourceAccessor.readRange` does, so `ModelLoadManager.load` sniffing
 * the format from a small prefix and starting `OcctDecodeEngineProxy`'s
 * lazy import before this file finishes downloading only happens because
 * `fromUrl` is now the source, not because this function does anything
 * differently.
 *
 * Failure here is expected, not a bug, when this file is opened directly
 * (`file://`): both fetching the STEP file and constructing the Worker
 * this needs throw immediately from an opaque `file://` origin — measured
 * by hand in a real browser, not assumed (DECISIONS.md). Caught here so
 * that case reports clearly instead of surfacing as an uncaught rejection
 * that would also blank out the cube's already-working status line.
 */
async function loadStepPart(
  loader: ModelLoader,
  spinning: Group,
  status: HTMLElement,
): Promise<void> {
  try {
    const model = await loader.load(
      fromUrl(STEP_FILE_URL, { name: "nist-ftc-11.stp" }),
    );

    if (model.diagnostics.some((d) => d.severity === "error")) {
      status.textContent += `\nSTEP: ${model.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("; ")}`;
      return;
    }

    const object = toThree(model);
    object.position.set(150, 0, 0);
    spinning.add(object);
    status.textContent += `\nSTEP: loaded ${model.meshes.length} mesh(es), ${model.tree.length} scene node(s).`;
  } catch (error) {
    // Diagnosed by the page's own protocol, not guessed from the fact that
    // something threw — over http(s), a thrown error here is a real
    // regression (a missing asset, a genuine decode failure), and
    // reporting the confident "needs http(s)" message anyway would send a
    // future debugger looking in the wrong place.
    const reason =
      location.protocol === "file:"
        ? "this half needs the page served over http(s), not opened as a file:// path"
        : "unexpected failure";
    status.textContent += `\nSTEP: skipped — ${reason}. (${String(error)})`;
  }
}

/**
 * Loads `nist-ctc-01.SLDPRT` and adds it to `spinning`, offset to the
 * opposite side from the STEP part so all three shapes stay visually
 * distinct. Same `fromUrl` reasoning, `file://` restriction and
 * catch-and-report handling as `loadStepPart` — see that function's doc
 * comment — since constructing a `Worker` is what throws here too, not
 * anything specific to wasm.
 */
async function loadSolidWorksPart(
  loader: ModelLoader,
  spinning: Group,
  status: HTMLElement,
): Promise<void> {
  try {
    const model = await loader.load(
      fromUrl(SOLIDWORKS_FILE_URL, { name: "nist-ctc-01.SLDPRT" }),
    );

    if (model.diagnostics.some((d) => d.severity === "error")) {
      status.textContent += `\nSolidWorks: ${model.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("; ")}`;
      return;
    }

    const object = toThree(model);
    object.position.set(-150, 0, 0);
    spinning.add(object);
    status.textContent += `\nSolidWorks: loaded ${model.meshes.length} mesh(es), ${model.tree.length} scene node(s).`;
  } catch (error) {
    const reason =
      location.protocol === "file:"
        ? "this half needs the page served over http(s), not opened as a file:// path"
        : "unexpected failure";
    status.textContent += `\nSolidWorks: skipped — ${reason}. (${String(error)})`;
  }
}

async function main(): Promise<void> {
  const status = statusElement();

  const loader = new ModelLoader(
    undefined,
    undefined,
    createStepDecoders(),
    createSolidWorksDecoders(),
  );
  const stl = fromBuffer(binaryStl(CUBE_TRIANGLES), "smoke-cube.stl");
  const model = await loader.load(stl);

  if (model.diagnostics.some((d) => d.severity === "error")) {
    status.textContent = model.diagnostics
      .map((d) => `${d.severity}: ${d.message}`)
      .join("\n");
    return;
  }
  status.textContent = `STL: loaded ${model.meshes.length} mesh(es), ${model.tree.length} scene node(s).`;

  const scene = new Scene();
  const spinning = new Group();
  spinning.add(toThree(model));
  scene.add(spinning);
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

  animate(renderer, scene, camera, spinning);

  await loadStepPart(loader, spinning, status);
  await loadSolidWorksPart(loader, spinning, status);
}

main().catch((error: unknown) => {
  statusElement().textContent = `Demo failed to start: ${String(error)}`;
});
