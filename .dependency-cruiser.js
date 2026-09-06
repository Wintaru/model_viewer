// The executable copy of the layer table in ARCHITECTURE.md section 2.
// Folders don't exist yet (they arrive in later slice-1 commits), so most of
// these rules match nothing today — that's expected. Once src/manager,
// src/engine, src/accessor, src/utility and src/common exist, a
// boundary-crossing import fails `depcruise src` instead of only living in
// prose. See REVIEW-BACKLOG.md, "the layer rules now live in four places".
export default {
  forbidden: [
    {
      name: "no-manager-to-manager",
      comment:
        "Manager must never call Manager. Re-compose at a higher Manager instead.",
      severity: "error",
      from: { path: "^src/manager/" },
      to: { path: "^src/manager/" },
    },
    {
      name: "no-engine-to-engine",
      comment:
        "Engine must never call Engine. Sequence multi-step formats from a Manager. A worker entry point (*.worker.ts) constructing and calling its own paired Engine worker-side is not that kind of edge — it has nothing above it but WorkerTransport (ARCHITECTURE.md section 3's main-thread/worker diagram) — so those files are exempt as the 'from' side here, unlike the Accessor rule's ModelSource/ModelCacheAccessor exemption below which narrows the TO side to an explicit allowlist. This blanket exemption is deliberately loosened only this far: the two rules immediately below narrow it back down per format, now that a second worker exists to make that worth enforcing. See DECISIONS.md and REVIEW-BACKLOG.md.",
      severity: "error",
      from: { path: "^src/engine/", pathNot: "\\.worker\\.ts$" },
      to: { path: "^src/engine/" },
    },
    {
      name: "occt-worker-only-imports-occt-engine",
      comment:
        "occt.worker.ts is exempted from no-engine-to-engine above so it can construct its own paired OcctDecodeEngine, not so it can reach any Engine at all. Narrows that exemption back to the one file it's actually for.",
      severity: "error",
      from: { path: "^src/engine/occt\\.worker\\.ts$" },
      to: {
        path: "^src/engine/",
        pathNot: "^src/engine/OcctDecodeEngine\\.ts$",
      },
    },
    {
      name: "solidworks-worker-only-imports-solidworks-engine",
      comment:
        "Same narrowing as occt-worker-only-imports-occt-engine, for solidworks.worker.ts and SolidWorksDecodeEngine.",
      severity: "error",
      from: { path: "^src/engine/solidworks\\.worker\\.ts$" },
      to: {
        path: "^src/engine/",
        pathNot: "^src/engine/SolidWorksDecodeEngine\\.ts$",
      },
    },
    {
      name: "dxf-worker-only-imports-dxf-engine",
      comment:
        "Same narrowing as occt-worker-only-imports-occt-engine, for dxf.worker.ts and DxfDecodeEngine.",
      severity: "error",
      from: { path: "^src/engine/dxf\\.worker\\.ts$" },
      to: {
        path: "^src/engine/",
        pathNot: "^src/engine/DxfDecodeEngine\\.ts$",
      },
    },
    {
      name: "no-engine-to-manager",
      comment: "Engine must never call upward into Manager.",
      severity: "error",
      from: { path: "^src/engine/" },
      to: { path: "^src/manager/" },
    },
    {
      name: "no-accessor-to-manager",
      comment: "Accessor must never call upward into Manager.",
      severity: "error",
      from: { path: "^src/accessor/" },
      to: { path: "^src/manager/" },
    },
    {
      name: "no-accessor-to-engine",
      comment:
        "Accessor must never call Engine — no business logic reached from an I/O boundary.",
      severity: "error",
      from: { path: "^src/accessor/" },
      to: { path: "^src/engine/" },
    },
    {
      name: "no-accessor-to-accessor",
      comment:
        "Accessors are leaf I/O and hold no logic; they must not depend on each other. Implementing the layer's own public contract (ModelSource, ModelCacheAccessor) is not the same thing as depending on a sibling Accessor, so those files are exempt — see DECISIONS.md.",
      severity: "error",
      from: { path: "^src/accessor/" },
      to: {
        path: "^src/accessor/",
        pathNot: "^src/accessor/(ModelSource|ModelCacheAccessor)\\.ts$",
      },
    },
    {
      name: "no-common-outbound",
      comment:
        "Common is the shared domain model. Anything may import it, but it must not reach into another layer — files within Common may still reference each other.",
      severity: "error",
      from: { path: "^src/common/" },
      to: { path: "^src/(manager|engine|accessor|utility)/" },
    },
    {
      name: "no-utility-outbound",
      comment:
        "Utility is a cross-cutting leaf: every layer may call it, and it calls nothing.",
      severity: "error",
      from: { path: "^src/utility/" },
      to: { path: "^src/(common|manager|engine|accessor|utility)/" },
    },
    {
      name: "no-three-adapter-outbound",
      comment:
        "The /three adapter (SPEC.md section 7a, section 8) is a pure consumer of Common's neutral model, not a layer in the loading pipeline. It must not reach into Manager, Engine, Accessor or Utility — doing so would risk the reverse edge (the core entry point importing /three) sneaking in later, which is the exact bundle-size problem D10 exists to prevent.",
      severity: "error",
      from: { path: "^src/three/" },
      to: { path: "^src/(manager|engine|accessor|utility)/" },
    },
  ],
  options: {
    // Test files aren't part of the runtime layer graph the rules above
    // enforce — a test legitimately reaches into whatever it exercises,
    // regardless of layer. Excluding them here, once, beats adding a
    // pathNot to every rule above.
    exclude: {
      path: "\\.test\\.ts$",
    },
    // The layer rules only govern our own src/ tree. Without this,
    // dependency-cruiser also crawls every package a dependency pulls in
    // (e.g. one test importing "vitest" cruised 26 modules instead of the
    // 3 that make up the actual src/ graph).
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    // verbatimModuleSyntax (tsconfig.json) means every type-only reference
    // is written as `import type`. Without this, dependency-cruiser drops
    // those edges entirely — a Common module built from nothing but `import
    // type` statements cruised as 0 internal dependencies, so a real
    // boundary-crossing type import would pass silently.
    tsPreCompilationDeps: true,
  },
};
