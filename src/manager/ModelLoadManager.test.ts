import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBuffer } from "../accessor/BufferSourceAccessor";
import type { ModelSource } from "../accessor/ModelSource";
import type { DecodedModel } from "../common/DecodedModel";
import { MeshDecodeEngine } from "../engine/MeshDecodeEngine";
import { ModuleRegistry } from "../utility/ModuleRegistry";
import {
  ModelLoadManager,
  type DxfDecoder,
  type SolidWorksDecoder,
  type StepDecoder,
} from "./ModelLoadManager";

/**
 * A minimal, this-file-only ambient type for the one Node global one
 * regression test below needs, to detect an unhandled promise rejection.
 * Not a project-wide `.d.ts` — `src/engine/node-fs.d.ts`'s own doc comment
 * explains why `@types/node` isn't added broadly (it would let Node's
 * ambient globals type-check inside `src/`, defeating this browser-only
 * library's one guard against accidentally reaching for a Node-only API).
 * A plain `declare const` here types only within this module instead. The
 * real `process` global Vitest's Node environment already provides at
 * runtime is untouched; this only satisfies the type checker.
 */
declare const process: {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
};

/** Yields enough microtask turns for a chain of already-settled promises
 * (an `await`, then a synchronous `ModuleRegistry.get()` call, then another
 * `await`) to fully unwind before an assertion inspects their side effects. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

interface Triangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

// TypeScript's typed arrays are generic over their backing buffer as of
// TS 5.7+. An unparameterized `Uint8Array` return annotation widens to the
// loose `Uint8Array<ArrayBufferLike>` default, which File/Blob's
// BlobPart type (and a plain `ArrayBuffer` slot) then reject — the
// annotation below keeps the more specific type `new Uint8Array(n)`
// actually has.
function binaryStl(triangles: readonly Triangle[]): Uint8Array<ArrayBuffer> {
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
    offset += 2;
  }
  return bytes;
}

const oneTriangle: Triangle = {
  normal: [0, 0, 1],
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
};

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** FormatSniffEngine's SolidWorks signature: bytes 4-7 are 00 00 00 04. */
function solidWorksBytes(): Uint8Array {
  return new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa, 0x00, 0x00, 0x00, 0x04]);
}

/** FormatSniffEngine's DXF signature: an ASCII "0" then "SECTION". */
function dxfBytes(): Uint8Array {
  return ascii("0\nSECTION\n");
}

describe("ModelLoadManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a binary STL given raw bytes (Uint8Array)", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(binaryStl([oneTriangle]));

    expect(model.meshes).toHaveLength(1);
    expect(model.meshes[0]?.positions).toHaveLength(9);
  });

  it("loads a binary STL given an ArrayBuffer", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(binaryStl([oneTriangle]).buffer);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given a File", async () => {
    const manager = new ModelLoadManager();
    const file = new File([binaryStl([oneTriangle])], "part.stl");

    const model = await manager.load(file);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given a plain Blob", async () => {
    const manager = new ModelLoadManager();
    const blob = new Blob([binaryStl([oneTriangle])]);

    const model = await manager.load(blob);

    expect(model.meshes).toHaveLength(1);
  });

  it("loads a binary STL given an already-built ModelSource", async () => {
    const manager = new ModelLoadManager();
    const source = fromBuffer(binaryStl([oneTriangle]), "part.stl");

    const model = await manager.load(source);

    expect(model.meshes).toHaveLength(1);
  });

  it("reports occt-decoder-not-configured for a STEP file with no decoder configured", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(ascii("ISO-10303-21;\nHEADER;\n"));

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "occt-decoder-not-configured",
      }),
    );
  });

  it("dispatches a STEP file to a configured decoder", async () => {
    let receivedBytes: Uint8Array | undefined;
    const fakeDecoder: StepDecoder = {
      transform: (bytes) => {
        receivedBytes = bytes;
        return Promise.resolve({
          units: "mm",
          meshes: [],
          tree: [],
          metadata: { source: "fake-occt" },
          diagnostics: [],
        });
      },
    };
    const stepDecoders = new ModuleRegistry<"step", StepDecoder>({
      step: () => Promise.resolve(fakeDecoder),
    });
    const manager = new ModelLoadManager(undefined, undefined, stepDecoders);
    const bytes = ascii("ISO-10303-21;\nHEADER;\n");

    const model = await manager.load(bytes);

    expect(model.metadata).toEqual({ source: "fake-occt" });
    expect(receivedBytes).toEqual(bytes);
  });

  it("rejects when the configured step decoder fails to resolve", async () => {
    const stepDecoders = new ModuleRegistry<"step", StepDecoder>({
      step: () => Promise.reject(new Error("chunk fetch failed")),
    });
    const manager = new ModelLoadManager(undefined, undefined, stepDecoders);

    await expect(
      manager.load(ascii("ISO-10303-21;\nHEADER;\n")),
    ).rejects.toThrow("chunk fetch failed");
  });

  it("dispatches a SolidWorks file to a configured decoder", async () => {
    let receivedBytes: Uint8Array | undefined;
    const fakeDecoder: SolidWorksDecoder = {
      transform: (bytes) => {
        receivedBytes = bytes;
        return Promise.resolve({
          units: "mm",
          meshes: [],
          tree: [],
          metadata: { source: "fake-solidworks" },
          diagnostics: [],
        });
      },
    };
    const solidWorksDecoders = new ModuleRegistry<
      "solidworks",
      SolidWorksDecoder
    >({
      solidworks: () => Promise.resolve(fakeDecoder),
    });
    // No "not configured" case to test here, unlike step: solidWorksDecoders
    // always has a real default, so the only thing worth injecting is a
    // fake decoder, in the fourth constructor slot.
    const manager = new ModelLoadManager(
      undefined,
      undefined,
      undefined,
      solidWorksDecoders,
    );
    const bytes = solidWorksBytes();

    const model = await manager.load(bytes);

    expect(model.metadata).toEqual({ source: "fake-solidworks" });
    expect(receivedBytes).toEqual(bytes);
  });

  it("rejects when the configured solidworks decoder fails to resolve", async () => {
    const solidWorksDecoders = new ModuleRegistry<
      "solidworks",
      SolidWorksDecoder
    >({
      solidworks: () => Promise.reject(new Error("chunk fetch failed")),
    });
    const manager = new ModelLoadManager(
      undefined,
      undefined,
      undefined,
      solidWorksDecoders,
    );

    await expect(manager.load(solidWorksBytes())).rejects.toThrow(
      "chunk fetch failed",
    );
  });

  it("dispatches a DXF file to a configured decoder", async () => {
    let receivedBytes: Uint8Array | undefined;
    const fakeDecoder: DxfDecoder = {
      transform: (bytes) => {
        receivedBytes = bytes;
        return Promise.resolve({
          units: "mm",
          meshes: [],
          tree: [],
          metadata: { source: "fake-dxf" },
          diagnostics: [],
        });
      },
    };
    const dxfDecoders = new ModuleRegistry<"dxf", DxfDecoder>({
      dxf: () => Promise.resolve(fakeDecoder),
    });
    // No "not configured" case to test here, same as solidworks:
    // dxfDecoders always has a real default, so the only thing worth
    // injecting is a fake decoder, in the sixth constructor slot (appended
    // after cache, not reordering the existing five).
    const manager = new ModelLoadManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dxfDecoders,
    );
    const bytes = dxfBytes();

    const model = await manager.load(bytes);

    expect(model.metadata).toEqual({ source: "fake-dxf" });
    expect(receivedBytes).toEqual(bytes);
  });

  it("rejects when the configured dxf decoder fails to resolve", async () => {
    const dxfDecoders = new ModuleRegistry<"dxf", DxfDecoder>({
      dxf: () => Promise.reject(new Error("chunk fetch failed")),
    });
    const manager = new ModelLoadManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dxfDecoders,
    );

    await expect(manager.load(dxfBytes())).rejects.toThrow(
      "chunk fetch failed",
    );
  });

  it("reports unrecognized-format for bytes matching no known format", async () => {
    const manager = new ModelLoadManager();

    const model = await manager.load(ascii("this is not a CAD file"));

    expect(model.meshes).toEqual([]);
    expect(model.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unrecognized-format",
      }),
    );
  });

  it("sniffs from a readRange prefix, not a full read, when the source supports it", async () => {
    const manager = new ModelLoadManager();
    let readRangeArgs: readonly [number, number] | undefined;
    const fullBytes = binaryStl([oneTriangle]);
    const source: ModelSource = {
      readRange: (start, end) => {
        readRangeArgs = [start, end];
        return Promise.resolve(fullBytes.subarray(start, end));
      },
      read: () => Promise.resolve(fullBytes),
    };

    const model = await manager.load(source);

    expect(readRangeArgs).toEqual([0, 4096]);
    expect(model.meshes).toHaveLength(1);
  });

  it("falls back to sniffing the full read when the source has no readRange", async () => {
    const manager = new ModelLoadManager();
    let readCalled = false;
    const source: ModelSource = {
      read: () => {
        readCalled = true;
        return Promise.resolve(binaryStl([oneTriangle]));
      },
    };

    const model = await manager.load(source);

    expect(readCalled).toBe(true);
    expect(model.meshes).toHaveLength(1);
  });

  it("starts resolving the step decoder before the full download finishes, when readRange is available", async () => {
    let stepLoaderCalled = false;
    let resolveRead!: (bytes: Uint8Array) => void;
    const readPromise = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    const bytes = ascii("ISO-10303-21;\nHEADER;\n");
    const source: ModelSource = {
      readRange: () => Promise.resolve(bytes),
      read: () => readPromise,
    };
    const fakeDecoder: StepDecoder = {
      transform: () =>
        Promise.resolve({
          units: "mm",
          meshes: [],
          tree: [],
          metadata: {},
          diagnostics: [],
        }),
    };
    const stepDecoders = new ModuleRegistry<"step", StepDecoder>({
      step: () => {
        stepLoaderCalled = true;
        return Promise.resolve(fakeDecoder);
      },
    });
    const manager = new ModelLoadManager(undefined, undefined, stepDecoders);

    const loadPromise = manager.load(source);
    await flushMicrotasks();
    expect(stepLoaderCalled).toBe(true);

    resolveRead(bytes);
    await loadPromise;
  });

  it("falls back to a full read-then-sniff when a binary STL doesn't fit the readRange prefix", async () => {
    const manager = new ModelLoadManager();
    // 100 triangles is 5,084 bytes (84-byte header + 100 * 50), comfortably
    // past SNIFF_PREFIX_BYTES (4,096) — FormatSniffEngine can't recognize
    // binary STL from a prefix that short (see its own doc comment), so
    // this only passes if load() re-sniffs the full bytes instead of
    // giving up on the prefix's `undefined` result.
    const manyTriangles = Array.from({ length: 100 }, () => oneTriangle);
    const fullBytes = binaryStl(manyTriangles);
    expect(fullBytes.byteLength).toBeGreaterThan(4096);
    let readCalled = false;
    const source: ModelSource = {
      readRange: (start, end) =>
        Promise.resolve(fullBytes.subarray(start, end)),
      read: () => {
        readCalled = true;
        return Promise.resolve(fullBytes);
      },
    };

    const model = await manager.load(source);

    expect(readCalled).toBe(true);
    expect(model.meshes).toHaveLength(1);
    expect(model.meshes[0]?.positions).toHaveLength(100 * 9);
  });

  it("does not leave a rejected decoder promise unhandled while the full download is still pending", async () => {
    let resolveRead!: (bytes: Uint8Array) => void;
    const readPromise = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    const bytes = ascii("ISO-10303-21;\nHEADER;\n");
    const source: ModelSource = {
      readRange: () => Promise.resolve(bytes),
      read: () => readPromise,
    };
    const stepDecoders = new ModuleRegistry<"step", StepDecoder>({
      step: () => Promise.reject(new Error("chunk fetch failed")),
    });
    const manager = new ModelLoadManager(undefined, undefined, stepDecoders);

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const loadPromise = manager.load(source);
      // Give the decoder's rejection a chance to be reported as unhandled
      // before the slow "download" below ever resolves — reproducing the
      // exact race this fix closes.
      await flushMicrotasks();
      resolveRead(bytes);
      await expect(loadPromise).rejects.toThrow("chunk fetch failed");
      await flushMicrotasks();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });

  it("routes a string URL through fromUrl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (
          _input: RequestInfo | URL,
          init?: RequestInit,
        ): ReturnType<typeof fetch> => {
          const fullBytes = binaryStl([oneTriangle]);
          if (init?.headers !== undefined) {
            return Promise.resolve(
              new Response(fullBytes.subarray(0, 4096), { status: 206 }),
            );
          }
          return Promise.resolve(new Response(fullBytes));
        },
      ),
    );
    const manager = new ModelLoadManager();

    const model = await manager.load("https://example.test/part.stl");

    expect(model.meshes).toHaveLength(1);
  });

  it("accepts injected engines, for testing without the real ones", async () => {
    const fakeSniffer = { transform: () => "stl" as const };
    const fakeDecoder = {
      transform: () => ({
        units: "mm" as const,
        meshes: [],
        tree: [],
        metadata: { source: "fake" },
        diagnostics: [],
      }),
    };
    const manager = new ModelLoadManager(fakeSniffer, fakeDecoder);

    const model = await manager.load(new Uint8Array(0));

    expect(model.metadata).toEqual({ source: "fake" });
  });
});

/** A trivial in-memory `ModelCacheAccessor`, standing in for a real
 * host-supplied one (IndexedDB, disk, …) — same "fake the public
 * interface" approach as `fakeSniffer`/`fakeDecoder` above. */
function inMemoryCache(): {
  load: (key: string) => Promise<DecodedModel | undefined>;
  store: (key: string, model: DecodedModel) => Promise<void>;
  entries: Map<string, DecodedModel>;
} {
  const entries = new Map<string, DecodedModel>();
  return {
    entries,
    load: (key) => Promise.resolve(entries.get(key)),
    store: (key, model) => {
      entries.set(key, model);
      return Promise.resolve();
    },
  };
}

describe("ModelLoadManager caching", () => {
  it("decodes once, then returns the cached model on a second load of identical bytes", async () => {
    const cache = inMemoryCache();
    let decodeCalls = 0;
    const fakeMeshDecoder = {
      transform: (): DecodedModel => {
        decodeCalls++;
        return {
          units: "mm",
          meshes: [],
          tree: [],
          metadata: { call: String(decodeCalls) },
          diagnostics: [],
        };
      },
    };
    const manager = new ModelLoadManager(
      undefined,
      fakeMeshDecoder,
      undefined,
      undefined,
      cache,
    );
    const bytes = binaryStl([oneTriangle]);

    const first = await manager.load(bytes);
    const second = await manager.load(bytes);

    expect(decodeCalls).toBe(1);
    expect(second).toEqual(first);
    expect(second.metadata).toEqual({ call: "1" });
  });

  it("derives the cache key from a content hash, the format, and the decoder version", async () => {
    const cache = inMemoryCache();
    const manager = new ModelLoadManager(
      undefined,
      new MeshDecodeEngine(),
      undefined,
      undefined,
      cache,
    );

    await manager.load(binaryStl([oneTriangle]));

    expect([...cache.entries.keys()]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}:stl:1$/),
    ]);
  });

  it("still returns the decoded model even if the cache's store rejects", async () => {
    const cache = inMemoryCache();
    const failingStore = vi
      .spyOn(cache, "store")
      .mockRejectedValue(new Error("cache backend is down"));
    const manager = new ModelLoadManager(
      undefined,
      new MeshDecodeEngine(),
      undefined,
      undefined,
      cache,
    );

    const model = await manager.load(binaryStl([oneTriangle]));

    expect(model.meshes).toHaveLength(1);
    expect(failingStore).toHaveBeenCalledTimes(1);
  });

  it("decodes every time when no ModelCacheAccessor is supplied", async () => {
    let decodeCalls = 0;
    const fakeMeshDecoder = {
      transform: (): DecodedModel => {
        decodeCalls++;
        return {
          units: "mm",
          meshes: [],
          tree: [],
          metadata: {},
          diagnostics: [],
        };
      },
    };
    const manager = new ModelLoadManager(undefined, fakeMeshDecoder);
    const bytes = binaryStl([oneTriangle]);

    await manager.load(bytes);
    await manager.load(bytes);

    expect(decodeCalls).toBe(2);
  });

  it("skips calling the configured step decoder on a warm cache", async () => {
    const cache = inMemoryCache();
    let transformCalls = 0;
    const fakeDecoder: StepDecoder = {
      transform: () => {
        transformCalls++;
        return Promise.resolve({
          units: "mm",
          meshes: [],
          tree: [],
          metadata: {},
          diagnostics: [],
        });
      },
    };
    const stepDecoders = new ModuleRegistry<"step", StepDecoder>({
      step: () => Promise.resolve(fakeDecoder),
    });
    const manager = new ModelLoadManager(
      undefined,
      undefined,
      stepDecoders,
      undefined,
      cache,
    );
    const bytes = ascii("ISO-10303-21;\nHEADER;\n");

    await manager.load(bytes);
    await manager.load(bytes);

    expect(transformCalls).toBe(1);
  });
});
