/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  {
    ignores: ["**/dist/**", "dev/src/browser/**"],
  },
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest
      },
      parserOptions: {
        // An explicit project rather than `projectService: true`: the project
        // service resolves each file to its nearest tsconfig, and the
        // per-workspace tsconfigs only include `src/**`, so test files would
        // not be found. Revisit once per-tree test tsconfigs exist.
        project: [
          "./tsconfig.eslint.json",
          // The build_setup fixtures are standalone projects with stricter
          // options (notably `noUncheckedIndexedAccess`); lint them as their
          // own tsc compiles them, not under the root config.
          "./tests/integration/build_setup/*/tsconfig.json"
        ],
        tsconfigRootDir: __dirname
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
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "error"
    },
  },
]);
