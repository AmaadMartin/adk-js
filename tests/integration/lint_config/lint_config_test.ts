/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {ESLint} from 'eslint';
import {describe, expect, it} from 'vitest';

/** Source trees linted with type information. */
const TYPE_CHECKED_FILES = [
  'core/src/runner/runner.ts',
  'integrations/src/index.ts',
];

/**
 * Trees deliberately left on the non-type-aware parse: the test trees are in no
 * tsconfig `include`, and dev/src resolves `@google/adk` through core/dist, so
 * its findings would depend on whether the tree happens to be built.
 */
const NON_TYPE_CHECKED_FILES = [
  'core/test/utils/task_test.ts',
  'dev/src/server/adk_api_server.ts',
];

/**
 * Core rules that typescript-eslint's `eslint-recommended` switches off and
 * `js/recommended` switches back on. They stay enabled only while the
 * type-aware block is ordered ahead of the `**\/*.ts` block.
 */
const CORE_RULES_PRESERVED_BY_BLOCK_ORDER = [
  'constructor-super',
  'getter-return',
  'no-class-assign',
  'no-const-assign',
  'no-dupe-args',
  'no-dupe-class-members',
  'no-dupe-keys',
  'no-func-assign',
  'no-import-assign',
  'no-new-native-nonconstructor',
  'no-obj-calls',
  'no-redeclare',
  'no-setter-return',
  'no-this-before-super',
  'no-undef',
  'no-unreachable',
  'no-unsafe-negation',
  'no-with',
];

/**
 * A rule that cannot run without type information: typescript-eslint throws
 * rather than reporting when the parser produced no program for the file.
 */
const TYPE_INFO_REQUIRED_RULE =
  '@typescript-eslint/no-unnecessary-type-assertion';

const ERROR = 2;
const OFF = 0;

const eslint = new ESLint();

function severityOf(
  config: Awaited<ReturnType<ESLint['calculateConfigForFile']>>,
  ruleId: string,
): number | undefined {
  const entry: unknown = config.rules?.[ruleId];
  return Array.isArray(entry) ? (entry[0] as number) : undefined;
}

function lintWithTypeInfoRequiredRule(): ESLint {
  return new ESLint({
    overrideConfig: {rules: {[TYPE_INFO_REQUIRED_RULE]: 'error'}},
  });
}

describe('ESLint type-aware configuration', () => {
  describe.each(TYPE_CHECKED_FILES)('%s', (file) => {
    it('is parsed against the per-package TypeScript programs', async () => {
      const config = await eslint.calculateConfigForFile(file);
      const {project, tsconfigRootDir} = config.languageOptions.parserOptions;

      expect(project).toEqual([
        './core/tsconfig.json',
        './integrations/tsconfig.json',
      ]);
      expect(tsconfigRootDir).toBe(process.cwd());
    });

    it('enables the type-checked rules that reached zero findings', async () => {
      const config = await eslint.calculateConfigForFile(file);

      expect(
        severityOf(config, '@typescript-eslint/no-floating-promises'),
      ).toBe(ERROR);
      expect(severityOf(config, '@typescript-eslint/no-misused-promises')).toBe(
        ERROR,
      );
      expect(severityOf(config, '@typescript-eslint/await-thenable')).toBe(
        ERROR,
      );
    });

    it('leaves the deferred rules off', async () => {
      const config = await eslint.calculateConfigForFile(file);

      expect(
        severityOf(config, '@typescript-eslint/no-unsafe-assignment'),
      ).toBe(OFF);
      expect(severityOf(config, '@typescript-eslint/require-await')).toBe(OFF);
    });

    it('keeps the core correctness rules the preset would disable', async () => {
      const config = await eslint.calculateConfigForFile(file);

      for (const rule of CORE_RULES_PRESERVED_BY_BLOCK_ORDER) {
        expect(severityOf(config, rule), rule).toBe(ERROR);
      }
    });
  });

  describe.each(NON_TYPE_CHECKED_FILES)('%s', (file) => {
    it('is not parsed with type information', async () => {
      const config = await eslint.calculateConfigForFile(file);

      expect(config.languageOptions.parserOptions.project).toBeUndefined();
    });

    it('does not enable the type-checked rules', async () => {
      const config = await eslint.calculateConfigForFile(file);

      expect(
        severityOf(config, '@typescript-eslint/no-floating-promises'),
      ).toBeUndefined();
    });
  });

  it('loads a TypeScript program and lints a source file cleanly', async () => {
    const [result] = await eslint.lintFiles(['core/src/utils/task.ts']);

    expect(result.messages).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it('runs a type-information-dependent rule over core/src', async () => {
    const [result] = await lintWithTypeInfoRequiredRule().lintFiles([
      'core/src/utils/task.ts',
    ]);

    expect(result.fatalErrorCount).toBe(0);
  });

  it('has no type information to give the test tree', async () => {
    await expect(
      lintWithTypeInfoRequiredRule().lintFiles([
        'core/test/utils/task_test.ts',
      ]),
    ).rejects.toThrow(/requires type information/);
  });
});
