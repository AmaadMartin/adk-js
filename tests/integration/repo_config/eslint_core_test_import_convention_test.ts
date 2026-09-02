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

const RULE_ID = 'no-restricted-imports';

const eslint = new ESLint({cwd: REPO_ROOT});

/**
 * Lints `source` as if it lived at `relativePath` and returns the messages the
 * import-convention guard produced. `lintText` resolves the real
 * `eslint.config.js` against that path, so this exercises the shipped config
 * rather than a copy of it, and writes nothing to disk.
 */
async function guardViolations(
  source: string,
  relativePath: string,
): Promise<string[]> {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(REPO_ROOT, relativePath),
  });
  return result.messages
    .filter((message) => message.ruleId === RULE_ID)
    .map((message) => message.message);
}

const RESTRICTED_IMPORTS = [
  ['the package root', "import {App} from '@google/adk';"],
  ['a type-only package root', "import type {App} from '@google/adk';"],
  ['a re-export', "export {App} from '@google/adk';"],
  [
    'a deep subpath',
    "import {Session} from '@google/adk/sessions/session.js';",
  ],
] as const;

describe('core/test ADK import convention', () => {
  it.each(RESTRICTED_IMPORTS)('rejects %s import', async (_label, source) => {
    const violations = await guardViolations(source, 'core/test/probe_test.ts');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'../../src/index.js'");
  });

  it('allows the relative source path the convention mandates', async () => {
    const violations = await guardViolations(
      "import {App} from '../../src/index.js';",
      'core/test/probe_test.ts',
    );

    expect(violations).toEqual([]);
  });

  it('leaves non-ADK package specifiers alone', async () => {
    const violations = await guardViolations(
      "import {Content} from '@google/genai';\nimport {z} from 'zod';",
      'core/test/probe_test.ts',
    );

    expect(violations).toEqual([]);
  });

  it('is scoped to core/test and does not restrict other test trees', async () => {
    const violations = await guardViolations(
      "import {App} from '@google/adk';",
      'dev/test/probe_test.ts',
    );

    expect(violations).toEqual([]);
  });
});
