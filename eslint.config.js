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
      ]
    },
  },
  {
    files: ["core/test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          "patterns": [
            {
              "group": ["@google/adk", "@google/adk/**"],
              "message":
                "core/test must import ADK symbols from the source tree via a relative path (e.g. '../../src/index.js'). The package specifier resolves through the workspace symlink to the built declarations in core/dist/types, so TypeScript sees two distinct declarations of every class, while vitest aliases it to core/src -- the type checker and the runtime disagree."
            }
          ]
        }
      ]
    },
  },
]);
