import { describe, expect, it } from "vitest";
import { sha256Hex } from "./HashUtil.js";

const encoder = new TextEncoder();

describe("sha256Hex", () => {
  it("matches the known SHA-256 digest of the empty input", async () => {
    await expect(sha256Hex(new Uint8Array(0))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('matches the known SHA-256 digest of "abc"', async () => {
    await expect(sha256Hex(encoder.encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes identical bytes identically", async () => {
    const bytes = encoder.encode("a longer, arbitrary payload");

    await expect(sha256Hex(bytes)).resolves.toBe(
      await sha256Hex(bytes.slice()),
    );
  });

  it("changes the digest when a single byte changes", async () => {
    const original = encoder.encode("a longer, arbitrary payload");
    const changed = original.slice();
    changed[0] = (changed[0] ?? 0) ^ 0xff;

    await expect(sha256Hex(changed)).resolves.not.toBe(
      await sha256Hex(original),
    );
  });
});
