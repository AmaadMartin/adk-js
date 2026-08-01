/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ESLint} from 'eslint';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/**
 * A path that never exists on disk: it only tells ESLint which config block
 * applies to the linted text, and `lintText` reads nothing from the
 * filesystem.
 */
const LINT_TARGET = path.join(REPO_ROOT, 'core/test/restricted_imports.ts');

const eslint = new ESLint({cwd: REPO_ROOT});

async function restrictedImportMessages(specifier: string): Promise<string[]> {
  const [result] = await eslint.lintText(`import '${specifier}';\n`, {
    filePath: LINT_TARGET,
  });
  return result.messages
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

describe('no-restricted-imports', () => {
  it('allows the package root specifiers', async () => {
    for (const specifier of [
      '@google/adk',
      '@google/adk-devtools',
      '@google/adk-integrations',
    ]) {
      expect(await restrictedImportMessages(specifier)).toEqual([]);
    }
  });

  it('rejects a subpath at any depth of any published package', async () => {
    for (const specifier of [
      '@google/adk/index.js',
      '@google/adk/utils/logger.js',
      '@google/adk/agents/processors/code_execution_request_processor.js',
      '@google/adk-devtools/server/adk_api_client.js',
      '@google/adk-integrations/foo.js',
    ]) {
      const messages = await restrictedImportMessages(specifier);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('exports maps declare only');
    }
  });
});
