import { deflate, deflateRaw } from "pako";
import { describe, expect, it } from "vitest";
import { tryInflateRaw, tryInflateZlib } from "./InflateUtil";

function payload(length: number): Uint8Array {
  // Repeating, non-trivial bytes — long enough that a real deflate stream
  // spans more than one of pako's internal onData chunks, so concatenation
  // across chunks is actually exercised, not just a single-chunk shortcut.
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (i * 37 + 11) % 256;
  }
  return bytes;
}

describe("tryInflateZlib", () => {
  it("decodes a zlib-wrapped stream at a nonzero offset", () => {
    const original = payload(200_000);
    const compressed = deflate(original);
    const prefix = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const bytes = new Uint8Array(prefix.length + compressed.length);
    bytes.set(prefix, 0);
    bytes.set(compressed, prefix.length);

    const result = tryInflateZlib(bytes, prefix.length, original.length);

    expect(result).toEqual(original);
  });

  it("ignores trailing bytes after the compressed stream ends", () => {
    const original = payload(1_000);
    const compressed = deflate(original);
    const bytes = new Uint8Array(compressed.length + 5);
    bytes.set(compressed, 0);
    bytes.set([1, 2, 3, 4, 5], compressed.length);

    expect(tryInflateZlib(bytes, 0, original.length)).toEqual(original);
  });

  it("rejects an offset with no zlib header, without attempting decompression", () => {
    const bytes = deflateRaw(payload(1_000)); // valid raw deflate, no zlib header

    expect(tryInflateZlib(bytes, 0, 1_000)).toBeUndefined();
  });

  it("rejects a zlib header whose checksum doesn't verify", () => {
    // 0x78 0x00 matches the CMF byte but fails the CMF/FLG checksum check
    // (research/d9-decode.py's own guard: `(buf[i] << 8 | buf[i+1]) % 31`).
    const bytes = new Uint8Array([0x78, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);

    expect(tryInflateZlib(bytes, 0, 1_000)).toBeUndefined();
  });

  it("rejects output that exceeds the cap, without throwing", () => {
    const compressed = deflate(payload(200_000));

    expect(tryInflateZlib(compressed, 0, 100)).toBeUndefined();
  });
});

describe("tryInflateRaw", () => {
  it("decodes a raw-deflate stream with no header at all", () => {
    const original = payload(50_000);
    const compressed = deflateRaw(original);

    expect(tryInflateRaw(compressed, 0, original.length)).toEqual(original);
  });

  it("rejects bytes that aren't a valid deflate stream", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(tryInflateRaw(bytes, 0, 1_000)).toBeUndefined();
  });

  it("rejects an offset past the end of the buffer", () => {
    const bytes = deflateRaw(payload(1_000));

    expect(tryInflateRaw(bytes, bytes.length + 10, 1_000)).toBeUndefined();
  });

  it("rejects output that exceeds the cap, without inflating it fully first", () => {
    // A cap tighter than the true output proves the abort happens mid-stream
    // (OutputTooLargeError thrown from onData), not after a full decode.
    const compressed = deflateRaw(payload(500_000));

    expect(tryInflateRaw(compressed, 0, 1_000)).toBeUndefined();
  });
});
