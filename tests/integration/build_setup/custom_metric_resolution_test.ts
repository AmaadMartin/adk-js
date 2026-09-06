/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The built entry point of each module format a consumer can reach. */
const ENTRY_POINTS = [
  {format: 'esm', entry: 'core/dist/esm/index.js'},
  {format: 'cjs', entry: 'core/dist/cjs/index.js'},
];

const ENTRY_ENV_VAR = 'ADK_ENTRY_URL';
const SPECIFIER_ENV_VAR = 'ADK_METRIC_SPECIFIER';

/** A metric module of the kind a developer keeps beside their eval data. */
const METRIC_MODULE = `
export function score() {
  return {overallScore: 0.5, overallEvalStatus: 1, perInvocationResults: []};
}
`;

const SCORE_SCRIPT = `
  const {CustomMetricEvaluator} = await import(process.env.${ENTRY_ENV_VAR});
  const evaluator = new CustomMetricEvaluator(
    {metricName: 'brevity', threshold: 0.5, criterion: {threshold: 0.5}},
    process.env.${SPECIFIER_ENV_VAR},
  );
  const result = await evaluator.evaluateInvocations([]);
  process.stdout.write(String(result.overallScore));
`;

/**
 * Scores one metric in a child Node process started in `cwd`.
 *
 * The child is what makes this suite meaningful: every vitest project aliases
 * `@google/adk` to `core/src`, and Vite rewrites the `import()` that loads the
 * metric module, so an in-process test resolves the specifier differently from
 * a real consumer.
 */
function scoreWith(entryPath: string, specifier: string, cwd: string) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', SCORE_SCRIPT],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        [ENTRY_ENV_VAR]: pathToFileURL(entryPath).href,
        [SPECIFIER_ENV_VAR]: specifier,
      },
    },
  );
}

describe.each(ENTRY_POINTS)(
  'custom metric specifier resolution ($format)',
  ({entry}) => {
    const entryPath = path.resolve(REPO_ROOT, entry);
    let projectDir: string;

    beforeAll(() => {
      expect(
        existsSync(entryPath),
        `${entry} is not built; run "npm run build" before this suite`,
      ).toBe(true);

      // Realpath, because macOS reports the system temp directory through a
      // symlink and the child process resolves its own working directory.
      projectDir = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'adk-metric-project-')),
      );
      writeFileSync(
        path.join(projectDir, 'metrics.mjs'),
        METRIC_MODULE,
        'utf-8',
      );
    });

    it('loads a relative path from the working directory', () => {
      const result = scoreWith(entryPath, './metrics.mjs#score', projectDir);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('0.5');
    });

    it('names the location it tried when the path is missing', () => {
      const result = scoreWith(entryPath, './absent.mjs#score', projectDir);
      const tried = pathToFileURL(path.join(projectDir, 'absent.mjs')).href;

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`(tried ${tried})`);
    });
  },
);
