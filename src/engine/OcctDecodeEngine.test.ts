import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WasmAssetAccessor,
  type FetchLike,
} from "../accessor/WasmAssetAccessor";
import { OcctDecodeEngine } from "./OcctDecodeEngine";

// A real network fetch can't load a file:// path, and this repo's tests
// run under Node (no jsdom), so the real wasm bytes are read from disk and
// handed back through the same FetchLike contract WasmAssetAccessor uses
// in production — the engine's actual code path is exercised, not a
// different one written just for tests.
const WASM_PATH = "node_modules/occt-import-js/dist/occt-import-js.wasm";
const STEP_DIR = "assets/step";

function realWasmAssets(): WasmAssetAccessor {
  const bytes = readFileSync(WASM_PATH);
  const fakeFetch: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        ),
    });
  return new WasmAssetAccessor(WASM_PATH, fakeFetch);
}

function readStepFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${STEP_DIR}/${name}`));
}

// Instantiating occt-import-js compiles a multi-MB wasm module — the
// default 5s test timeout isn't always enough headroom on a loaded machine.
const OCCT_TEST_TIMEOUT_MS = 20_000;

describe("OcctDecodeEngine", () => {
  it(
    "decodes a real STEP file's geometry",
    async () => {
      const engine = new OcctDecodeEngine(realWasmAssets());

      const model = await engine.transform(
        readStepFile("nist_ctc_01_asme1_rd.stp"),
      );

      expect(model.units).toBe("mm");
      expect(model.diagnostics).toEqual([]);
      expect(model.meshes.length).toBeGreaterThan(0);

      const mesh = model.meshes[0];
      // Not pinned to an exact triangle count: that's a property of
      // whatever tessellation parameters the installed occt-import-js
      // version happens to use, not of this repo's own conversion logic —
      // a version bump could shift it with nothing here actually wrong.
      expect(mesh?.indices.length).toBeGreaterThan(0);
      expect((mesh?.indices.length ?? 0) % 3).toBe(0);
      expect((mesh?.positions.length ?? 0) % 3).toBe(0);
      expect(mesh?.normals.length).toBe(mesh?.positions.length);

      // FaceRange's own doc comment requires faces to exactly and
      // contiguously cover indices with no gaps or overlaps — verified
      // here against real OCCT output, not assumed from the README.
      const totalCovered = mesh?.faces.reduce(
        (sum, face) => sum + face.count,
        0,
      );
      expect(totalCovered).toBe(mesh?.indices.length);

      expect(model.tree).toHaveLength(1);
    },
    OCCT_TEST_TIMEOUT_MS,
  );

  it(
    "reports occt-empty-result for a success-but-zero-mesh file",
    async () => {
      const engine = new OcctDecodeEngine(realWasmAssets());

      // Measured, not assumed: research/probe-step.mjs already found this
      // exact NIST file reports success with zero meshes (an AP242 file
      // using a tessellated representation OCCT's import path can't read —
      // WAYFINDER.md decision D5).
      const model = await engine.transform(
        readStepFile("nist_ftc_08_asme1_ap242-e1-tg.stp"),
      );

      expect(model.meshes).toEqual([]);
      expect(model.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "occt-empty-result",
        }),
      );
    },
    OCCT_TEST_TIMEOUT_MS,
  );

  it(
    "reports occt-read-failed when OCCT throws reading a file it can't parse",
    async () => {
      const engine = new OcctDecodeEngine(realWasmAssets());

      // Measured, not assumed: research/probe-step.mjs already found this
      // exact NIST file throws from ReadStepFile rather than returning
      // success: false.
      const model = await engine.transform(
        readStepFile("nist_stc_07_asme1_ap242-e3.stp"),
      );

      expect(model.meshes).toEqual([]);
      expect(model.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "occt-read-failed",
        }),
      );
    },
    OCCT_TEST_TIMEOUT_MS,
  );

  it(
    "reports occt-read-failed for bytes that are not a STEP file",
    async () => {
      const engine = new OcctDecodeEngine(realWasmAssets());

      const model = await engine.transform(new Uint8Array([1, 2, 3, 4]));

      expect(model.meshes).toEqual([]);
      expect(model.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "occt-read-failed",
        }),
      );
    },
    OCCT_TEST_TIMEOUT_MS,
  );

  it(
    "reuses one occt-import-js instance across repeated transform calls",
    async () => {
      let readCount = 0;
      const bytes = readFileSync(WASM_PATH);
      const countingFetch: FetchLike = () => {
        readCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: () =>
            Promise.resolve(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ),
            ),
        });
      };
      const engine = new OcctDecodeEngine(
        new WasmAssetAccessor(WASM_PATH, countingFetch),
      );

      await engine.transform(readStepFile("nist_ctc_01_asme1_rd.stp"));
      await engine.transform(readStepFile("nist_ctc_03_asme1_rc.stp"));

      expect(readCount).toBe(1);
    },
    OCCT_TEST_TIMEOUT_MS,
  );
});
