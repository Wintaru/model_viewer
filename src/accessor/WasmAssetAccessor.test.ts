import { afterEach, describe, expect, it, vi } from "vitest";
import { WasmAssetAccessor, type FetchLike } from "./WasmAssetAccessor";

function fakeFetch(
  response: Partial<Awaited<ReturnType<FetchLike>>> & { readonly ok: boolean },
): FetchLike {
  return () =>
    Promise.resolve({
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      arrayBuffer:
        response.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
    });
}

describe("WasmAssetAccessor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the fetched bytes on a successful response", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const accessor = new WasmAssetAccessor(
      "https://example.test/occt.wasm",
      fakeFetch({ ok: true, arrayBuffer: () => Promise.resolve(bytes) }),
    );

    await expect(accessor.read()).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("throws a descriptive error when the response is not ok", async () => {
    const accessor = new WasmAssetAccessor(
      "https://example.test/occt.wasm",
      fakeFetch({ ok: false, status: 404, statusText: "Not Found" }),
    );

    await expect(accessor.read()).rejects.toThrow(
      "Failed to fetch the OCCT wasm binary from https://example.test/occt.wasm: 404 Not Found",
    );
  });

  it("propagates a network failure instead of swallowing it", async () => {
    const failingFetch: FetchLike = () =>
      Promise.reject(new Error("network dropped"));
    const accessor = new WasmAssetAccessor(
      "https://example.test/occt.wasm",
      failingFetch,
    );

    await expect(accessor.read()).rejects.toThrow("network dropped");
  });

  it("uses the global fetch when none is injected", async () => {
    const bytes = new Uint8Array([9, 8, 7]).buffer;
    vi.stubGlobal(
      "fetch",
      fakeFetch({ ok: true, arrayBuffer: () => Promise.resolve(bytes) }),
    );
    const accessor = new WasmAssetAccessor("https://example.test/occt.wasm");

    await expect(accessor.read()).resolves.toEqual(new Uint8Array([9, 8, 7]));
  });
});
