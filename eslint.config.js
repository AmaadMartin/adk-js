/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["**/dist/**", "dev/src/browser/**"],
  },
  tseslint.configs.recommended,
  // Type-aware linting for the published source trees. This block must stay
  // ahead of the "**/*.ts" block below: `recommendedTypeCheckedOnly` bundles
  // typescript-eslint's `eslint-recommended`, which switches off 18 core rules
  // (no-undef, no-const-assign, no-unreachable, ...) that "js/recommended"
  // re-enables afterwards.
  {
    files: ["core/src/**/*.ts", "integrations/src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        project: ["./core/tsconfig.json", "./integrations/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Pre-existing findings, deferred for staged adoption rather than
      // suppressed: burn each count down and re-enable the rule.
      "@typescript-eslint/no-base-to-string": "off", // 4 findings, 4 files
      "@typescript-eslint/no-redundant-type-constituents": "off", // 4 findings, 4 files
      "@typescript-eslint/no-unnecessary-type-assertion": "off", // 82 findings, 38 files
      "@typescript-eslint/no-unsafe-argument": "off", // 3 findings, 3 files
      "@typescript-eslint/no-unsafe-assignment": "off", // 34 findings, 11 files
      "@typescript-eslint/no-unsafe-call": "off", // 6 findings, 4 files
      "@typescript-eslint/no-unsafe-enum-comparison": "off", // 8 findings, 4 files
      "@typescript-eslint/no-unsafe-member-access": "off", // 42 findings, 5 files
      "@typescript-eslint/no-unsafe-return": "off", // 3 findings, 3 files
      "@typescript-eslint/require-await": "off", // 69 findings, 37 files
      "@typescript-eslint/restrict-plus-operands": "off", // 4 findings, 2 files
      "@typescript-eslint/restrict-template-expressions": "off", // 26 findings, 14 files
    },
  },
  {
    files: ["**/*.ts"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ]
    },
  },
]);
