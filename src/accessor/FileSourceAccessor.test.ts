import { describe, expect, it } from "vitest";
import { fromFile } from "./FileSourceAccessor";

describe("fromFile", () => {
  it("reads back the same bytes given a File", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "part.stl");

    const source = fromFile(file);

    expect(await source.read()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("reads back the same bytes given a plain Blob", async () => {
    const blob = new Blob([new Uint8Array([9, 8, 7])]);

    const source = fromFile(blob);

    expect(await source.read()).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("reports byteLength from size", () => {
    const source = fromFile(new Blob([new Uint8Array(5)]));

    expect(source.byteLength).toBe(5);
  });

  it("reports byteLength from size for a File too", () => {
    const source = fromFile(new File([new Uint8Array(7)], "part.stl"));

    expect(source.byteLength).toBe(7);
  });

  it("takes name from the File's own name when none is given", () => {
    const source = fromFile(new File([], "part.stl"));

    expect(source.name).toBe("part.stl");
  });

  it("prefers an explicit name over the File name", () => {
    const source = fromFile(new File([], "part.stl"), "renamed.stl");

    expect(source.name).toBe("renamed.stl");
  });

  it("leaves name undefined for a plain Blob with no explicit name", () => {
    const source = fromFile(new Blob([]));

    expect(source.name).toBeUndefined();
  });

  it("does not implement readRange or stream", () => {
    const source = fromFile(new Blob([]));

    expect("readRange" in source).toBe(false);
    expect("stream" in source).toBe(false);
  });
});
