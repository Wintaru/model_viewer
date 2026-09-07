import { describe, expect, it } from "vitest";
import { createEmptyDecodedModel } from "../common/DecodedModel.js";
import { ModelExportManager } from "./ModelExportManager.js";

const model = createEmptyDecodedModel({
  severity: "error",
  code: "unsupported-format",
  message: "test fixture",
});

describe("ModelExportManager", () => {
  it("wraps GltfEncodeEngine's bytes in a Blob with the glTF mime type", async () => {
    const manager = new ModelExportManager();

    const blob = await manager.export(model, { format: "gltf" });

    expect(blob.type).toBe("model/gltf+json");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      asset: { version: "2.0" },
    });
  });

  it("delegates to the injected GltfEncodeEngine, not a real one", async () => {
    const fakeBytes = new TextEncoder().encode('{"asset":{"version":"fake"}}');
    const fakeEncoder = { transform: () => fakeBytes };
    const manager = new ModelExportManager(fakeEncoder);

    const blob = await manager.export(model, { format: "gltf" });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"asset":{"version":"fake"}}',
    );
  });
});
