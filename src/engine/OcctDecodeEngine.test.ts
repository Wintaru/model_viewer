import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WasmAssetAccessor,
  type FetchLike,
} from "../accessor/WasmAssetAccessor.js";
import { OcctDecodeEngine } from "./OcctDecodeEngine.js";

// A real network fetch can't load a file:// path, and this repo's tests
// run under Node (no jsdom), so the real wasm bytes are read from disk and
// handed back through the same FetchLike contract WasmAssetAccessor uses
// in production — the engine's actual code path is exercised, not a
// different one written just for tests.
const WASM_PATH = "node_modules/occt-import-js/dist/occt-import-js.wasm";
const STEP_DIR = "assets/step";
const IGES_DIR = "assets/iges";

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

function readIgesFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${IGES_DIR}/${name}`));
}

// Instantiating occt-import-js compiles a multi-MB wasm module — the
// default 5s test timeout isn't always enough headroom on a loaded machine.
const OCCT_TEST_TIMEOUT_MS = 20_000;

// The test corpus is not in git — `pnpm assets` fetches it (assets/README.md).
// A case that needs it skips when it is absent, rather than failing, so a
// fresh clone can run `pnpm test` and get a meaningful result. CI fails when
// anything skips, so these cases really do run there — see
// .github/workflows/ci.yml and scripts/check-no-skipped-tests.mjs.
//
// STEP and IGES get separate guards because scripts/fetch-assets.sh downloads
// them under separate conditions. One guard covering both would crash on an
// ENOENT exactly where it was supposed to skip.
const itWithStepCorpus = it.skipIf(
  !existsSync(`${STEP_DIR}/nist_ctc_01_asme1_rd.stp`),
);
const itWithIgesCorpus = it.skipIf(!existsSync(`${IGES_DIR}/ex1.iges`));

describe("OcctDecodeEngine", () => {
  itWithStepCorpus(
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

  itWithStepCorpus(
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

  itWithStepCorpus(
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
    "reports occt-read-failed for bytes that don't look like STEP either (routed to ReadIgesFile)",
    async () => {
      // No ISO-10303-21; header, so transform() routes these bytes to
      // ReadIgesFile rather than ReadStepFile — exercising that reader's
      // own reject-on-garbage behavior, not the STEP one below.
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
    "reports occt-read-failed for a STEP-signed file ReadStepFile can't parse",
    async () => {
      // Starts with the real STEP signature, so transform() routes this to
      // ReadStepFile specifically, isolating that reader's own
      // reject-on-garbage behavior from ReadIgesFile's above. Confirmed by
      // hand: OCCT returns success: false (not a throw) for this input.
      const engine = new OcctDecodeEngine(realWasmAssets());

      const model = await engine.transform(
        new TextEncoder().encode("ISO-10303-21;\nnot a real STEP file\n"),
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

  itWithIgesCorpus(
    "recognizes real IGES files and reports occt-empty-result for them",
    async () => {
      // assets/iges (research/FINDINGS.md section 10, WAYFINDER.md's IGES
      // follow-up): three real IGES 5.3 files, none holding solid or
      // surface geometry — this
      // proves transform() correctly routes to ReadIgesFile (not
      // ReadStepFile, which would reject these outright) and that the
      // honest-empty-result diagnostic applies to IGES the same way it
      // already does to STEP (D5). A real positive decode — an IGES file
      // whose solid geometry actually produces triangles — is still open
      // follow-up work; see assets/README.md.
      const engine = new OcctDecodeEngine(realWasmAssets());

      for (const name of ["ex1.iges", "ex2.iges", "ex3.iges"]) {
        const model = await engine.transform(readIgesFile(name));

        expect(model.meshes).toEqual([]);
        expect(model.diagnostics).toContainEqual(
          expect.objectContaining({
            severity: "error",
            code: "occt-empty-result",
          }),
        );
      }
    },
    OCCT_TEST_TIMEOUT_MS,
  );

  itWithStepCorpus(
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
