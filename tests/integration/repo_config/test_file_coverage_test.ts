/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {globSync} from 'tinyglobby';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {TestProjectConfiguration} from 'vitest/config';
import vitestConfig from '../../../vitest.config.js';

// Vitest runs a test file only when some project's `include` glob matches it.
// A file that matches no glob is skipped in silence: no warning, no error, no
// "0 tests found". The contributor then reads a green build as a passing test.
// These assertions turn that silence into a build failure.

/**
 * Filenames a contributor would reasonably expect Vitest to run: the repo's own
 * `*_test` convention, plus the `.test.`/`.spec.` names Vitest collects by
 * default over the same extensions as its default `include`.
 */
const TEST_FILE_PATTERNS = [
  '**/*_test.{ts,tsx,cts,mts,js,jsx,cjs,mjs}',
  '**/*.test.{ts,tsx,cts,mts,js,jsx,cjs,mjs}',
  '**/*.spec.{ts,tsx,cts,mts,js,jsx,cjs,mjs}',
];

/**
 * Directories that hold no repository source. `.git` is already skipped by
 * tinyglobby's default `dot: false`; listing it keeps this set independent of
 * that default.
 */
const IGNORED_DIRS = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * `include` globs declared across every project in vitest.config.ts. Throws on
 * a project this guard cannot read: a project it silently skipped would be
 * exactly the gap it exists to close.
 */
function declaredIncludes(
  projects: TestProjectConfiguration[] | undefined,
): string[] {
  if (!projects) {
    throw new Error(
      'vitest.config.ts declares no test.projects; the test-file coverage ' +
        'guard in tests/integration/repo_config needs updating.',
    );
  }
  return projects.flatMap((project, index) => {
    const include =
      typeof project === 'object' && 'test' in project
        ? project.test?.include
        : undefined;
    // A project that declares no `include` inherits Vitest's default include
    // rather than collecting nothing, so this guard cannot guess what it runs.
    if (!Array.isArray(include) || include.length === 0) {
      throw new Error(
        'Cannot read a string[] test.include from vitest.config.ts project ' +
          `#${index}; the test-file coverage guard in ` +
          'tests/integration/repo_config needs updating.',
      );
    }
    return include;
  });
}

/** Test-looking files under `rootDir` that no `includePatterns` glob collects. */
function uncollectedTestFiles(
  rootDir: string,
  includePatterns: string[],
): string[] {
  // Both sides go through the same call shape, so both yield POSIX-separated
  // paths relative to `rootDir` and the set difference holds on Windows too.
  // `expandDirectories: false` evaluates each declared glob as written instead
  // of letting tinyglobby rewrite a directory-shaped pattern into `dir/**/*`.
  const options = {
    cwd: rootDir,
    ignore: IGNORED_DIRS,
    expandDirectories: false,
  };
  const collected = new Set(globSync(includePatterns, options));
  return globSync(TEST_FILE_PATTERNS, options)
    .filter((file) => !collected.has(file))
    .sort();
}

describe('test file coverage', () => {
  it('every test-looking file is collected by a vitest project', () => {
    const includes = declaredIncludes(vitestConfig.test?.projects);

    expect(
      uncollectedTestFiles(REPO_ROOT, includes),
      'These files look like tests but no vitest project collects them, so ' +
        'they never run. Move each one under a path an existing project ' +
        "collects, or add its directory to that project's `include` in " +
        `vitest.config.ts. Declared includes: ${includes.join(', ')}`,
    ).toEqual([]);
  });
});

describe('uncollected test files', () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'adk-test-file-coverage-'));
    for (const file of [
      'pkg/test/collected_test.ts',
      'pkg/test/nested/collected_test.ts',
      'pkg/stray_test.ts',
      'pkg/test/dot_form.test.ts',
      'node_modules/dep/vendor_test.ts',
      'dist/built_test.ts',
    ]) {
      const target = path.join(fixtureRoot, file);
      mkdirSync(path.dirname(target), {recursive: true});
      writeFileSync(target, '');
    }
  });

  afterAll(() => {
    rmSync(fixtureRoot, {recursive: true, force: true});
  });

  it('reports every test file the include globs miss', () => {
    expect(
      uncollectedTestFiles(fixtureRoot, ['pkg/test/**/*_test.ts']),
    ).toEqual(['pkg/stray_test.ts', 'pkg/test/dot_form.test.ts']);
  });

  it('reports nothing when an include glob collects every test file', () => {
    expect(
      uncollectedTestFiles(fixtureRoot, [
        'pkg/**/*_test.ts',
        'pkg/**/*.test.ts',
      ]),
    ).toEqual([]);
  });
});

describe('vitest include parsing', () => {
  it('rejects a config that declares no projects', () => {
    expect(() => declaredIncludes(undefined)).toThrow(
      /declares no test.projects/,
    );
  });

  it('rejects a project whose include it cannot read', () => {
    expect(() => declaredIncludes(['glob/*'])).toThrow(/project #0/);
    expect(() => declaredIncludes([{}])).toThrow(/project #0/);
    expect(() => declaredIncludes([{test: {}}])).toThrow(/project #0/);
    expect(() => declaredIncludes([{test: {include: []}}])).toThrow(
      /project #0/,
    );
  });

  it('flattens the includes of every project', () => {
    expect(
      declaredIncludes([
        {test: {include: ['a/**/*_test.ts']}},
        {test: {include: ['b/**/*_test.ts', 'c/**/*_test.ts']}},
      ]),
    ).toEqual(['a/**/*_test.ts', 'b/**/*_test.ts', 'c/**/*_test.ts']);
  });
});
