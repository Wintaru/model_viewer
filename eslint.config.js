import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Flat config does not read .gitignore, so demo/private/ (decoded
    // third-party CAD output — see the comment in .gitignore) and dist/
    // (build output, commit 12) are repeated here by hand. Keep the two in
    // sync.
    // demo/library-demo.bundle.js, demo/occt.worker.bundle.js,
    // demo/solidworks.worker.bundle.js and demo/dxf.worker.bundle.js are
    // generated (scripts/build-library-demo.mjs, commits 14, slice 2
    // commit 7, slice 3 commit 7 and slice 6 commit 7) — bundled,
    // unformatted single files, same category as demo/viewer.html and
    // dist/.
    ignores: [
      "node_modules/",
      "demo/private/",
      ".playwright-mcp/",
      "dist/",
      "demo/library-demo.bundle.js",
      "demo/occt.worker.bundle.js",
      "demo/solidworks.worker.bundle.js",
      "demo/dxf.worker.bundle.js",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["research/**/*.mjs", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    // Not under src/, so not part of the typed src/**/*.ts project above —
    // esbuild bundles this file (scripts/build-library-demo.mjs) without
    // type-checking it at all, so this is syntax-only linting, not the full
    // typed rule set. Still needs its own block: without one, the untyped
    // js.configs.recommended above tries to parse TypeScript syntax
    // (interfaces, type annotations) with the default JS parser and fails.
    files: ["demo/library-demo.ts"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Same stance as the src/**/*.ts block above, minus
      // no-floating-promises — that one needs type info this untyped
      // block doesn't have.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  eslintConfigPrettier,
);
