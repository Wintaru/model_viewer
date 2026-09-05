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
        "Engine must never call Engine. Sequence multi-step formats from a Manager.",
      severity: "error",
      from: { path: "^src/engine/" },
      to: { path: "^src/engine/" },
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
        "Accessors are leaf I/O and hold no logic; they must not depend on each other.",
      severity: "error",
      from: { path: "^src/accessor/" },
      to: { path: "^src/accessor/" },
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
  ],
  options: {
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
  },
};
