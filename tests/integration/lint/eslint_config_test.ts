/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ESLint} from 'eslint';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '../../..');

// A path outside `test/` and `tests/`, where the chained form is legitimate.
const SOURCE_FILE = path.join(REPO_ROOT, 'core/src/index.ts');

const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
});

/** Lints `code` as if it were the file at `filePath`. */
async function restrictedSyntaxErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, {filePath});
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('vi.fn() module fakes in mock factories', () => {
  it.each([
    'mockImplementation(() => 1)',
    'mockResolvedValue(1)',
    'mockReturnValue(1)',
    'mockRejectedValue(new Error("boom"))',
  ])('rejects vi.fn().%s inside a vi.mock() factory', async (chained) => {
    const errors = await restrictedSyntaxErrors(
      `vi.mock('./m.js', () => ({f: vi.fn().${chained}}));`,
      THIS_FILE,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('pass the implementation to vi.fn()');
  });

  it('rejects the chained form inside a vi.hoisted() factory', async () => {
    const errors = await restrictedSyntaxErrors(
      `const f = vi.hoisted(() => vi.fn().mockResolvedValue(1));`,
      THIS_FILE,
    );

    expect(errors).toHaveLength(1);
  });

  it('rejects a chained call that overrides a vi.fn() constructor argument', async () => {
    const errors = await restrictedSyntaxErrors(
      `vi.mock('./m.js', () => ({f: vi.fn(async () => 1).mockResolvedValue(2)}));`,
      THIS_FILE,
    );

    expect(errors).toHaveLength(1);
  });

  it('accepts an implementation passed to the vi.fn() constructor', async () => {
    const errors = await restrictedSyntaxErrors(
      `vi.mock('./m.js', () => ({f: vi.fn(async () => 1), g: vi.fn(() => 2)}));`,
      THIS_FILE,
    );

    expect(errors).toEqual([]);
  });

  it('accepts a bare vi.fn() module fake', async () => {
    const errors = await restrictedSyntaxErrors(
      `vi.mock('./m.js', () => ({f: vi.fn()}));`,
      THIS_FILE,
    );

    expect(errors).toEqual([]);
  });

  it('accepts the chained form outside a mock factory', async () => {
    const errors = await restrictedSyntaxErrors(
      `const f = vi.fn().mockReturnValue(1);\nf();`,
      THIS_FILE,
    );

    expect(errors).toEqual([]);
  });

  it('does not apply outside test directories', async () => {
    const errors = await restrictedSyntaxErrors(
      `vi.mock('./m.js', () => ({f: vi.fn().mockReturnValue(1)}));`,
      SOURCE_FILE,
    );

    expect(errors).toEqual([]);
  });
});
