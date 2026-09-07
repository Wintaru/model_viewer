import { describe, expect, it, vi } from "vitest";
import { ModuleRegistry } from "./ModuleRegistry.js";

describe("ModuleRegistry", () => {
  it("resolves the module a loader returns", async () => {
    const registry = new ModuleRegistry<"a", { value: string }>({
      a: () => Promise.resolve({ value: "module a" }),
    });

    await expect(registry.get("a")).resolves.toEqual({ value: "module a" });
  });

  it("imports a key's module at most once across repeated calls", async () => {
    const loader = vi.fn(() => Promise.resolve({ value: "module a" }));
    const registry = new ModuleRegistry<"a", { value: string }>({
      a: loader,
    });

    await registry.get("a");
    await registry.get("a");

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight import between calls made before it settles", async () => {
    const loader = vi.fn(() => Promise.resolve({ value: "module a" }));
    const registry = new ModuleRegistry<"a", { value: string }>({
      a: loader,
    });

    const [first, second] = [registry.get("a"), registry.get("a")];

    expect(loader).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe(await second);
  });

  it("imports each key through its own loader", async () => {
    const registry = new ModuleRegistry<"a" | "b", { value: string }>({
      a: () => Promise.resolve({ value: "module a" }),
      b: () => Promise.resolve({ value: "module b" }),
    });

    await expect(registry.get("a")).resolves.toEqual({ value: "module a" });
    await expect(registry.get("b")).resolves.toEqual({ value: "module b" });
  });

  it("retries on the next call after a rejected import", async () => {
    const loader = vi
      .fn<() => Promise<{ value: string }>>()
      .mockRejectedValueOnce(new Error("network dropped"))
      .mockResolvedValueOnce({ value: "module a" });
    const registry = new ModuleRegistry<"a", { value: string }>({
      a: loader,
    });

    await expect(registry.get("a")).rejects.toThrow("network dropped");
    await expect(registry.get("a")).resolves.toEqual({ value: "module a" });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
