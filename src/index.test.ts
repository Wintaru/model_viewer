import { describe, expect, it } from "vitest";
import * as entryPoint from "./index";

describe("entry point", () => {
  it("exposes exactly the public surface SPEC.md section 7a documents", () => {
    expect(Object.keys(entryPoint).sort()).toStrictEqual(
      [
        "ModelLoader",
        "ModuleRegistry",
        "fromBuffer",
        "fromFile",
        "fromResponse",
        "fromUrl",
      ].sort(),
    );
  });
});
