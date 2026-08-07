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
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          "patterns": [
            {
              "group": ["@google-cloud/vertexai/build/**"],
              // Neither the Sessions class nor the Language enum has a
              // root-level re-export, and both are dereferenced at runtime,
              // so they need a deep value import.
              "allowImportNames": ["Sessions", "Language"],
              "allowTypeImports": true,
              "message": "Deep paths into the @google-cloud/vertexai build output bypass the package entry point and break when it reorganises that output. Import values from '@google-cloud/vertexai'; use a type-only import for symbols that have no root-level re-export."
            }
          ]
        }
      ],
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
