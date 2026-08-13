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
      ],
      // esbuild erases a type-only import from the emitted JavaScript, but it
      // still records the statement in `metafile.inputs` as a static edge that
      // is byte-identical to a real runtime dependency. Only a top-level
      // `import type` drops the edge; `import {type Foo}` does not. So require
      // "separate-type-imports" and keep the reported import graph honest.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          "fixStyle": "separate-type-imports",
          // Leave `import()` type annotations alone. A type-position
          // `import()` contributes nothing to `metafile.inputs`, so banning it
          // buys no build-graph accuracy, and every site in the repo is the
          // idiomatic `importOriginal<typeof import("...")>()` of a `vi.mock`
          // factory.
          "disallowTypeAnnotations": false
        }
      ]
    },
  },
]);
