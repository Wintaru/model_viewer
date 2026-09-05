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
    ignores: ["node_modules/", "demo/private/", ".playwright-mcp/", "dist/"],
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
    files: ["research/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
