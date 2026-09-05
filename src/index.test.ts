import { describe, expect, it } from "vitest";
import * as entryPoint from "./index";

describe("entry point", () => {
  it("loads under Vitest and TypeScript together, with no accidental exports", () => {
    expect(Object.keys(entryPoint)).toStrictEqual([]);
  });
});
