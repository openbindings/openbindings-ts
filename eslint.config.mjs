// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Lint tier: eslint recommended + typescript-eslint recommendedTypeChecked.
// Type-aware linting is cheap here (seconds for the whole workspace), so the
// type-checked variant is on. Deliberately NOT strict/stylistic: prettier is
// not part of this repo's source toolchain, so formatting/stylistic rules
// stay out.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", // CI checks out the sibling spec and interfaces repos INSIDE the
    // workspace (ci.yml `path: spec` / `path: interfaces`) for the
    // conformance corpora; their scripts are not ours to lint.
    "spec/**", "interfaces/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The test program (tsconfig.test.json) is a superset of the runtime
        // program (all of src, node types), so it type-covers the test files
        // the runtime tsconfig excludes; packages without a test split are
        // fully covered by their runtime tsconfig. Runtime tsconfigs are
        // listed first so runtime files resolve to the runtime program.
        project: [
          "packages/*/tsconfig.json",
          "packages/*/tsconfig.test.json",
          "packages/*/tsconfig.bench.json",
          "examples/react-operation-dependencies/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase uses the `_` prefix for contract-mandated bindings a
      // body does not consume (hook signatures, mock parameters).
      // ignoreRestSiblings is the standard companion for `{ a, ...rest }`
      // omission destructuring.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Test files relax rules whose purpose is protecting runtime code:
    files: ["**/*.test.ts"],
    rules: {
      // Fixtures are intentionally malformed / loosely typed to exercise
      // validation paths; the unsafe-* family and no-explicit-any guard
      // shipped code, not fixtures.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Mocks implement Promise-returning invoker/synthesizer interfaces
      // without awaiting anything inside.
      "@typescript-eslint/require-await": "off",
      // Fake servers stringify payloads that are strings by construction.
      "@typescript-eslint/no-base-to-string": "off",
      // Async event listeners / queued callbacks are idiomatic in tests: a
      // rejection surfaces as an unhandled rejection and fails the run
      // loudly. The conditional/spread checks stay on.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
  {
    // Files outside every tsconfig program (workspace/package config files
    // and package scripts): lint without type information.
    files: [
      "*.ts",
      "*.mjs",
      "scripts/**/*.ts",
      "scripts/**/*.mjs",
      "packages/*/*.ts",
          "packages/*/scripts/**/*.ts",
      "examples/*/scripts/**/*.mjs",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
