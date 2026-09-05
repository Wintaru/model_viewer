import { describe, expect, it } from "vitest";
import { FormatSniffEngine } from "./FormatSniffEngine";

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function binaryStl(triangleCount: number): Uint8Array {
  const HEADER_SIZE = 80;
  const bytes = new Uint8Array(HEADER_SIZE + 4 + triangleCount * 50);
  new DataView(bytes.buffer).setUint32(HEADER_SIZE, triangleCount, true);
  return bytes;
}

describe("FormatSniffEngine", () => {
  const sniff = new FormatSniffEngine();

  it("recognizes a STEP file", () => {
    expect(sniff.transform(ascii("ISO-10303-21;\nHEADER;\n"))).toBe("step");
  });

  it("recognizes a STEP file with leading whitespace", () => {
    expect(sniff.transform(ascii("  \nISO-10303-21;\n"))).toBe("step");
  });

  it("recognizes a SolidWorks container by bytes 4-7", () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x00, 0x00, 0x00, 0x04], 4);
    // A per-file id in bytes 0-3, unrelated to the signature — see
    // ARCHITECTURE.md section 4 on why bytes 0-3 must not be used.
    bytes.set([0xde, 0xad, 0xbe, 0xef], 0);

    expect(sniff.transform(bytes)).toBe("solidworks");
  });

  it("returns undefined for an all-zero buffer (matches no signature)", () => {
    const bytes = new Uint8Array(16);

    expect(sniff.transform(bytes)).toBeUndefined();
  });

  it("recognizes a DXF file", () => {
    expect(sniff.transform(ascii("0\r\nSECTION\r\n"))).toBe("dxf");
  });

  it("recognizes a DXF file with a padded group code", () => {
    expect(sniff.transform(ascii("  0\nSECTION\n"))).toBe("dxf");
  });

  it("recognizes an ASCII STL file", () => {
    expect(sniff.transform(ascii("solid part\nendsolid part\n"))).toBe("stl");
  });

  it("recognizes an ASCII STL file regardless of case", () => {
    expect(sniff.transform(ascii("SOLID part\n"))).toBe("stl");
  });

  it("recognizes a binary STL file when given the whole file", () => {
    expect(sniff.transform(binaryStl(2))).toBe("stl");
  });

  it("does not recognize a binary STL file from a short prefix", () => {
    const wholeFile = binaryStl(1000);
    const prefix = wholeFile.subarray(0, 4096);

    expect(sniff.transform(prefix)).toBeUndefined();
  });

  it("returns undefined for unrecognized bytes", () => {
    expect(sniff.transform(ascii("this is not a CAD file"))).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(sniff.transform(new Uint8Array(0))).toBeUndefined();
  });
});
