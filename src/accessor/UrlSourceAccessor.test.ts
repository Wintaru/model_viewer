import { afterEach, describe, expect, it, vi } from "vitest";
import { fromUrl } from "./UrlSourceAccessor";

describe("fromUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the fetched bytes on a successful response", async () => {
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]))),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    await expect(source.read()).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("throws a descriptive error when the response is not ok", async () => {
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      ),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    await expect(source.read()).rejects.toThrow(
      "Failed to fetch https://example.test/part.stp: 404 Not Found",
    );
  });

  it("propagates a network failure instead of swallowing it", async () => {
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.reject(new Error("network dropped")),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    await expect(source.read()).rejects.toThrow("network dropped");
  });

  it("uses the global fetch when none is injected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((): ReturnType<typeof fetch> =>
        Promise.resolve(new Response(new Uint8Array([9, 8, 7]))),
      ),
    );
    const source = fromUrl("https://example.test/part.stp");

    await expect(source.read()).resolves.toEqual(new Uint8Array([9, 8, 7]));
  });

  it("forwards the configured headers and an abort signal to fetch", async () => {
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.resolve(new Response(null)),
    );
    const controller = new AbortController();
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
      headers: { Authorization: "Bearer token" },
    });

    await source.read(controller.signal);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/part.stp",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
        signal: controller.signal,
      }),
    );
  });

  it("takes the explicit name when given", () => {
    const source = fromUrl("https://example.test/part.stp", {
      name: "renamed.stp",
    });

    expect(source.name).toBe("renamed.stp");
  });

  it("leaves name undefined when none is given", () => {
    const source = fromUrl("https://example.test/part.stp");

    expect(source.name).toBeUndefined();
  });

  it("sends a Range header for readRange and returns a 206's body as-is", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([10, 11, 12, 13]), { status: 206 }),
      ),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    const bytes = await source.readRange?.(0, 4);

    expect(bytes).toEqual(new Uint8Array([10, 11, 12, 13]));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/part.stp",
      expect.objectContaining({
        headers: expect.any(Headers) as Headers,
      }),
    );
    const sentHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(sentHeaders.get("range")).toBe("bytes=0-3");
  });

  it("preserves the configured headers alongside Range", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array(4), { status: 206 })),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
      headers: { Authorization: "Bearer token" },
    });

    await source.readRange?.(0, 4);

    const sentHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(sentHeaders.get("authorization")).toBe("Bearer token");
    expect(sentHeaders.get("range")).toBe("bytes=0-3");
  });

  it("slices the response locally when the server ignores Range and answers 200", async () => {
    const wholeFile = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.resolve(new Response(wholeFile, { status: 200 })),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    await expect(source.readRange?.(2, 5)).resolves.toEqual(
      new Uint8Array([3, 4, 5]),
    );
  });

  it("throws a descriptive error when readRange's response is not ok", async () => {
    const fetchImpl = vi.fn((): ReturnType<typeof fetch> =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      ),
    );
    const source = fromUrl("https://example.test/part.stp", {
      fetch: fetchImpl,
    });

    await expect(source.readRange?.(0, 4)).rejects.toThrow(
      "Failed to fetch https://example.test/part.stp: 404 Not Found",
    );
  });
});
