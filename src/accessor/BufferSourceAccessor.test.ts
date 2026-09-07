import { describe, expect, it } from "vitest";
import { fromBuffer } from "./BufferSourceAccessor.js";

describe("fromBuffer", () => {
  it("reads back the same bytes given an ArrayBuffer", async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;

    const source = fromBuffer(buffer);

    expect(await source.read()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("reads back the same bytes given a Uint8Array", async () => {
    const bytes = new Uint8Array([9, 8, 7]);

    const source = fromBuffer(bytes);

    expect(await source.read()).toEqual(bytes);
  });

  it("reports the view's own length for a Uint8Array sub-view", async () => {
    const backing = new ArrayBuffer(10);
    const view = new Uint8Array(backing, 2, 4);
    view.set([5, 6, 7, 8]);

    const source = fromBuffer(view);

    expect(source.byteLength).toBe(4);
    expect(await source.read()).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  it("reports byteLength", () => {
    const source = fromBuffer(new Uint8Array(5));

    expect(source.byteLength).toBe(5);
  });

  it("carries the name when given one", () => {
    const source = fromBuffer(new Uint8Array(0), "part.stl");

    expect(source.name).toBe("part.stl");
  });

  it("leaves name undefined when none is given", () => {
    const source = fromBuffer(new Uint8Array(0));

    expect(source.name).toBeUndefined();
  });

  it("does not implement readRange or stream", () => {
    const source = fromBuffer(new Uint8Array(0));

    expect("readRange" in source).toBe(false);
    expect("stream" in source).toBe(false);
  });
});
